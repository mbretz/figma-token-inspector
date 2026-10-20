import {
  RADIUS_FIELDS,
  SCALAR_FIELDS,
  STROKE_FIELDS,
  type Binding,
  type BridgeRequest,
  type BridgeResponse,
  type ChainLink,
  type NodeTokens,
  type PropertyDefinition,
  type TokenInfo,
  type TokenResult,
  type VariantChange,
  type VariantDiff,
} from "../../shared/types";

figma.showUI(__html__, { width: 260, height: 110 });

const MAX_CHAIN = 12;
/** Path of a root node; children are "Child / Grandchild", relative to their root. */
const ROOT = "(root)";
/** token id + the node's active modes -> resolved token, so each token is resolved once per request. */
let tokenCache = new Map<string, Promise<TokenInfo | null>>();

type VarCache = Map<string, Promise<Variable | null>>;

interface WalkOpts {
  maxDepth: number;
  includeUnbound: boolean;
  includeVectors: boolean;
  includeIcons: boolean;
}

/** Collects each distinct token once; nodes refer to it by key. */
class Registry {
  tokens: Record<string, TokenInfo> = {};
  private idToKey = new Map<string, string>();
  add(t: TokenInfo): string {
    const existing = this.idToKey.get(t.id as string);
    if (existing) return existing;
    let key = t.name;
    if (this.tokens[key]) key = `${t.collection ?? "?"}/${t.name}`;
    const { id, remote, ...rest } = t;
    this.tokens[key] = remote === false ? { ...rest, local: true } : rest;
    this.idToKey.set(id as string, key);
    return key;
  }
}

/** One property -> token (or literal) fact, used for variant diffing. */
interface FlatFact {
  property: string;
  value: string;
}

figma.ui.onmessage = async (msg: BridgeRequest) => {
  const res: BridgeResponse = { id: msg.id, ok: true };
  try {
    res.result = await handle(msg);
  } catch (e) {
    res.ok = false;
    res.error = e instanceof Error ? e.message : String(e);
  }
  figma.ui.postMessage(res);
};

async function handle(req: BridgeRequest): Promise<unknown> {
  const { action, params } = req;
  if (action === "list_variables") return listVariables(params.collection, params.nameFilter);
  if (action === "get_variant_diff") return variantDiff(params);

  let nodes: readonly SceneNode[];
  if (action === "get_selection_tokens") {
    nodes = figma.currentPage.selection;
    if (!nodes.length) throw new Error("Nothing is selected in Figma.");
  } else {
    const found: SceneNode[] = [];
    for (const id of params.nodeIds ?? []) {
      const n = await figma.getNodeByIdAsync(id.replace(/-/g, ":"));
      if (n && "visible" in n) found.push(n as SceneNode);
    }
    if (!found.length) throw new Error("No matching nodes found for the given IDs on any loaded page.");
    nodes = found;
  }

  return collect(nodes, {
    maxDepth: params.depth ?? Infinity,
    includeUnbound: !!params.includeUnbound,
    includeVectors: !!params.includeVectors,
    includeIcons: !!params.includeIcons,
  });
}

async function collect(roots: readonly SceneNode[], opts: WalkOpts): Promise<TokenResult> {
  const cache: VarCache = new Map();
  const registry = new Registry();
  const out: NodeTokens[] = [];
  tokenCache = new Map();
  for (const n of roots) await walk(n, ROOT, 0, opts, cache, registry, out);
  return { nodeCount: out.length, tokens: registry.tokens, nodes: out };
}

// ---------- tree walk ----------

function isVectorLike(node: SceneNode): boolean {
  return (
    node.type === "VECTOR" ||
    node.type === "BOOLEAN_OPERATION" ||
    node.type === "LINE" ||
    node.type === "STAR" ||
    node.type === "POLYGON" ||
    node.type === "ELLIPSE"
  );
}

async function walk(
  node: SceneNode,
  path: string,
  level: number,
  opts: WalkOpts,
  cache: VarCache,
  registry: Registry,
  out: NodeTokens[],
  flatOut?: { path: string; flat: FlatFact[] }[]
) {
  const { entry, flat } = await inspectNode(node, path, level, opts, cache, registry);
  // Vector internals add nothing unless they carry a binding.
  const emit = entry.bindings.length > 0 || opts.includeVectors || !isVectorLike(node);
  if (emit) {
    out.push(entry);
    flatOut?.push({ path, flat });
  }
  // A boolean operation's own bindings are reported, but its child shapes are skipped.
  const descend = "children" in node && level < opts.maxDepth && (opts.includeVectors || !isVectorLike(node));
  if (descend) {
    for (const child of (node as ChildrenMixin).children as readonly SceneNode[]) {
      await walk(child, path === ROOT ? child.name : `${path} / ${child.name}`, level + 1, opts, cache, registry, out, flatOut);
    }
  }
}

// ---------- node inspection ----------

function isAlias(v: unknown): v is VariableAlias {
  return !!v && typeof v === "object" && (v as VariableAlias).type === "VARIABLE_ALIAS";
}

/** Recursively find every alias in a boundVariables-shaped value. Nothing bound is dropped. */
function collectAliases(value: unknown, prop: string, acc: { property: string; id: string }[]) {
  if (isAlias(value)) {
    acc.push({ property: prop, id: value.id });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectAliases(v, `${prop}[${i}]`, acc));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) collectAliases(v, `${prop}.${k}`, acc);
  }
}

async function inspectNode(
  node: SceneNode,
  path: string,
  level: number,
  opts: WalkOpts,
  cache: VarCache,
  registry: Registry
): Promise<{ entry: NodeTokens; flat: FlatFact[] }> {
  const found: { property: string; id: string }[] = [];
  const bound = ("boundVariables" in node ? node.boundVariables : undefined) as
    | Record<string, unknown>
    | undefined;

  // Node-level bindings (strokeWeight, per-side weights, padding, radii, text, componentProperties...)
  if (bound) for (const [k, v] of Object.entries(bound)) collectAliases(v, k, found);

  // Paint / effect / grid level bindings (fills[i].boundVariables.color etc.)
  for (const field of ["fills", "strokes", "effects", "layoutGrids"] as const) {
    const arr = (node as any)[field];
    if (!Array.isArray(arr)) continue;
    arr.forEach((item: any, i: number) => {
      if (item?.boundVariables) collectAliases(item.boundVariables, `${field}[${i}]`, found);
    });
  }

  // De-dupe (node.boundVariables.fills and fills[i].boundVariables can both report the same alias)
  const seen = new Set<string>();
  const unique = found
    .map((f) => ({ property: normalizeProp(f.property), id: f.id }))
    .filter((f) => {
      const key = `${f.property}|${f.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  // Resolve each distinct token once, then group the properties that share it.
  const flat: FlatFact[] = [];
  const groups = new Map<string, { properties: string[]; token?: string; unresolvedAliasId?: string }>();
  const boundProps: string[] = [];
  for (const f of unique) {
    boundProps.push(f.property);
    const token = await cachedToken(f.id, node, cache);
    let g = groups.get(f.id);
    if (!g) {
      g = token ? { properties: [], token: registry.add(token) } : { properties: [], unresolvedAliasId: f.id };
      groups.set(f.id, g);
    }
    g.properties.push(f.property);
    flat.push({
      property: f.property,
      value: token ? `${token.name} (${String(token.resolvedValue)})` : `unresolved ${f.id}`,
    });
  }
  const bindings: Binding[] = [...groups.values()].map((g) => ({ ...g, properties: collapseProps(g.properties) }));

  const entry: NodeTokens = {
    nodeId: node.id,
    name: node.name,
    type: node.type,
    path,
    bindings,
  };

  const fact = (property: string, v: unknown) => flat.push({ property, value: JSON.stringify(v) });
  if (level > 0 && node.parent && "children" in node.parent) {
    entry.index = (node.parent.children as readonly SceneNode[]).indexOf(node);
  }
  if ("children" in node) {
    const kids = node.children as readonly SceneNode[];
    entry.childCount = kids.length;
    const hiddenKids = kids.filter((c) => c.visible === false).length;
    if (hiddenKids) entry.hiddenChildCount = hiddenKids;
  }
  if ((node as any).visible === false) {
    entry.hidden = true;
    fact("hidden", true);
  }
  const refs = (node as any).componentPropertyReferences as Record<string, string> | null | undefined;
  if (refs && Object.keys(refs).length) {
    entry.propertyRefs = refs;
    fact("propertyRefs", refs);
  }
  if (typeof (node as any).opacity === "number") {
    entry.opacity = (node as any).opacity;
    fact("opacity", entry.opacity);
  }
  const reactions = reactionInfo(node);
  if (reactions) entry.reactions = reactions;
  const annotations = annotationInfo(node);
  if (annotations) {
    entry.annotations = annotations;
    fact("annotations", annotations);
  }

  const layout = layoutInfo(node);
  if (layout) {
    entry.layout = layout;
    for (const [k, v] of Object.entries(layout)) flat.push({ property: `layout.${k}`, value: JSON.stringify(v) });
  }
  const component = await componentInfo(node);
  if (component) entry.component = component;
  const text = textInfo(node);
  if (text) {
    entry.text = text;
    for (const [k, v] of Object.entries(text)) flat.push({ property: `text.${k}`, value: JSON.stringify(v) });
  }
  if (opts.includeIcons && (await isIcon(node))) {
    try {
      entry.svg = await (node as InstanceNode).exportAsync({ format: "SVG_STRING" });
    } catch {}
  }
  const effects = effectTypes(node);
  if (effects) {
    entry.effects = effects;
    flat.push({ property: "effects", value: effects.join(",") });
  }

  if (opts.includeUnbound) {
    const unbound = collectUnbound(node, boundProps);
    if (unbound) {
      entry.unboundValues = unbound;
      for (const [k, v] of Object.entries(unbound)) flat.push({ property: `unbound.${k}`, value: JSON.stringify(v) });
    }
  }
  return { entry, flat };
}

/** fills[0] (node-level) and fills[0].color (paint-level) are the same binding. */
function normalizeProp(p: string): string {
  return p.replace(/\.color$/, "");
}

/** Shorten symmetric property lists: four radii -> cornerRadius, left+right padding -> paddingInline, etc. */
function collapseProps(props: string[]): string[] {
  let p = [...props];
  const take = (names: readonly string[], replacement: string) => {
    if (names.every((n) => p.includes(n))) p = [...p.filter((x) => !names.includes(x)), replacement];
  };
  take(RADIUS_FIELDS, "cornerRadius");
  take(STROKE_FIELDS, "strokeWeight");
  take(["paddingLeft", "paddingRight", "paddingTop", "paddingBottom"], "padding");
  take(["paddingLeft", "paddingRight"], "paddingInline");
  take(["paddingTop", "paddingBottom"], "paddingBlock");
  return p;
}

// ---------- structure ----------

function layoutInfo(node: SceneNode): Record<string, unknown> | undefined {
  const n = node as any;
  const o: Record<string, unknown> = {};
  const get = (k: string) => {
    try {
      return n[k];
    } catch {
      return undefined;
    }
  };
  const mode = get("layoutMode");
  if (mode && mode !== "NONE") {
    o.layoutMode = mode;
    o.primaryAxisAlignItems = get("primaryAxisAlignItems");
    o.counterAxisAlignItems = get("counterAxisAlignItems");
    if (get("layoutWrap") === "WRAP") o.layoutWrap = "WRAP";
  }
  const h = get("layoutSizingHorizontal");
  const v = get("layoutSizingVertical");
  if (h) o.sizingHorizontal = h;
  if (v) o.sizingVertical = v;
  // Rendered size, whether fixed, hug or fill.
  if (typeof n.width === "number" && typeof n.height === "number") {
    o.size = { width: Math.round(n.width * 100) / 100, height: Math.round(n.height * 100) / 100 };
  }
  if (get("layoutGrow")) o.layoutGrow = get("layoutGrow");
  const align = get("layoutAlign");
  if (align && align !== "INHERIT") o.layoutAlign = align;
  for (const k of ["minWidth", "maxWidth", "minHeight", "maxHeight"]) {
    const x = get(k);
    if (typeof x === "number") o[k] = x;
  }
  if (get("clipsContent") === true) o.clipsContent = true;
  if (get("layoutWrap") === "WRAP") o.layoutWrap = "WRAP";
  const pos = get("layoutPositioning");
  if (pos && pos !== "AUTO") o.layoutPositioning = pos;
  // Stroke alignment only matters when a stroke is actually painted.
  const strokes = get("strokes");
  if (Array.isArray(strokes) && strokes.some((p: Paint) => p.visible !== false)) {
    const align = get("strokeAlign");
    if (align) o.strokeAlign = align;
  }
  return Object.keys(o).length ? o : undefined;
}

function parseVariantName(name: string): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const part of name.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const v = part.slice(i + 1).trim();
    out[part.slice(0, i).trim()] = v === "true" ? true : v === "false" ? false : v;
  }
  return out;
}

async function componentInfo(node: SceneNode): Promise<Record<string, unknown> | undefined> {
  if (node.type === "COMPONENT") {
    const inSet = node.parent?.type === "COMPONENT_SET";
    if (inSet) return { variantProperties: parseVariantName(node.name), componentSet: node.parent!.name };
    const defs = propertyDefinitions(node);
    return Object.keys(defs).length ? { component: node.name, properties: defs } : { component: node.name };
  }
  if (node.type === "INSTANCE") {
    const o: Record<string, unknown> = {};
    try {
      const main = await node.getMainComponentAsync();
      if (main) {
        o.mainComponent = main.parent?.type === "COMPONENT_SET" ? main.parent.name : main.name;
        if (main.parent?.type === "COMPONENT_SET") o.variantProperties = parseVariantName(main.name);
      }
    } catch {}
    const props: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(node.componentProperties ?? {})) {
      if ((p as any).type !== "INSTANCE_SWAP") {
        props[k] = (p as any).value;
        continue;
      }
      const id = (p as any).value as string;
      let name: string | undefined;
      try {
        const target = await figma.getNodeByIdAsync(id);
        if (target) name = target.name;
      } catch {}
      props[k] = { swap: name ?? "(unresolved)", id };
    }
    if (Object.keys(props).length) o.properties = props;
    return Object.keys(o).length ? o : undefined;
  }
  return undefined;
}

function textInfo(node: SceneNode): Record<string, unknown> | undefined {
  if (node.type !== "TEXT") return undefined;
  const o: Record<string, unknown> = { characters: node.characters };
  const fn = node.fontName;
  if (fn && typeof fn === "object" && "style" in fn) o.fontStyle = fn.style;
  // Always reported, so "none" is distinguishable from "not read".
  if (typeof node.textCase === "string") o.textCase = node.textCase;
  if (typeof node.textDecoration === "string") o.textDecoration = node.textDecoration;
  if (typeof node.textTruncation === "string") o.textTruncation = node.textTruncation;
  if (typeof node.maxLines === "number") o.maxLines = node.maxLines;
  const ls = node.letterSpacing;
  if (ls && typeof ls === "object" && "value" in ls) o.letterSpacing = ls;
  if (typeof node.paragraphSpacing === "number") o.paragraphSpacing = node.paragraphSpacing;
  o.textAlignHorizontal = node.textAlignHorizontal;
  o.textAlignVertical = node.textAlignVertical;
  return o;
}

function effectTypes(node: SceneNode): string[] | undefined {
  const arr = (node as any).effects;
  if (!Array.isArray(arr)) return undefined;
  return arr.filter((e: Effect) => e.visible !== false).map((e: Effect) => e.type as string);
}

function reactionInfo(node: SceneNode): any[] | undefined {
  let rs: any;
  try {
    rs = (node as any).reactions;
  } catch {
    return undefined;
  }
  if (!Array.isArray(rs) || !rs.length) return undefined;
  return rs.map((r: any) => ({
    trigger: r.trigger?.type,
    ...(r.trigger?.timeout !== undefined ? { timeout: r.trigger.timeout } : {}),
    actions: (r.actions ?? (r.action ? [r.action] : [])).map((a: any) => ({
      type: a.type,
      ...(a.destinationId ? { destinationId: a.destinationId } : {}),
      ...(a.navigation ? { navigation: a.navigation } : {}),
      // null = instant (no animation); a missing key would be indistinguishable from "not read".
      ...(a.type === "NODE" || a.transition !== undefined
        ? {
            transition: a.transition
              ? {
                  type: a.transition.type,
                  easing: a.transition.easing?.type,
                  duration: a.transition.duration,
                  ...(a.transition.direction ? { direction: a.transition.direction } : {}),
                }
              : null,
          }
        : {}),
    })),
  }));
}

/** One short line per reaction, e.g. "ON_HOVER -> CHANGE_TO 288:1517 (instant)". */
function reactionSummary(rs: any[] | undefined): string[] | undefined {
  if (!rs) return undefined;
  return rs.map((r) => {
    const acts = (r.actions as any[]).map((a) => {
      let t = "";
      if (a.transition === null) t = " (instant)";
      else if (a.transition) {
        const e = a.transition.easing ? ` ${a.transition.easing}` : "";
        t = ` (${a.transition.type}${e} ${a.transition.duration}ms)`;
      }
      return `${a.navigation ?? a.type}${a.destinationId ? ` ${a.destinationId}` : ""}${t}`;
    });
    return `${r.trigger} -> ${acts.join(", ")}`;
  });
}

function annotationInfo(node: SceneNode): unknown[] | undefined {
  let as: any;
  try {
    as = (node as any).annotations;
  } catch {
    return undefined;
  }
  if (!Array.isArray(as) || !as.length) return undefined;
  return as.map((a: any) => ({
    label: a.labelMarkdown ?? a.label,
    ...(a.properties?.length ? { properties: a.properties.map((p: any) => p.type) } : {}),
  }));
}

/** The innermost small instance made only of vector shapes (no text, no nested instances), i.e. an icon. */
async function isIcon(node: SceneNode): Promise<boolean> {
  if (node.type !== "INSTANCE" || node.width > 64 || node.height > 64) return false;
  if (node.findOne((n) => n.type === "TEXT" || n.type === "INSTANCE")) return false;
  return !!node.findOne((n) => isVectorLike(n));
}

// ---------- unbound literals ----------

/**
 * Hard-coded values with no variable bound. Aggregate and per-side properties are reconciled
 * so that a bound per-side value never leaves a spurious "unbound" aggregate behind.
 */
function collectUnbound(node: SceneNode, boundProps: string[]): Record<string, unknown> | undefined {
  const n = node as any;
  const out: Record<string, unknown> = {};
  const isBound = (f: string) => boundProps.some((p) => p === f || p.startsWith(`${f}[`) || p.startsWith(`${f}.`));
  const vector = isVectorLike(node);

  const group = (sides: readonly string[], aggregate: string, active: boolean) => {
    if (!active) return;
    const unboundSides = sides.filter((s) => !isBound(s) && typeof n[s] === "number" && n[s] !== 0);
    if (!unboundSides.length) return;
    const values = unboundSides.map((s) => n[s]);
    if (unboundSides.length === sides.length && values.every((x) => x === values[0])) out[aggregate] = values[0];
    else for (const s of unboundSides) out[s] = n[s];
  };

  const strokes = Array.isArray(n.strokes) && n.strokes.some((p: Paint) => p.visible !== false);
  group(STROKE_FIELDS, "strokeWeight", strokes);
  group(RADIUS_FIELDS, "cornerRadius", !vector);

  const autoLayout = n.layoutMode && n.layoutMode !== "NONE";
  for (const f of SCALAR_FIELDS) {
    if (isBound(f) || !(f in n)) continue;
    if (vector && (f === "width" || f === "height")) continue;
    // Hug/fill sizes are computed by layout, not hard-coded.
    if (f === "width" && n.layoutSizingHorizontal && n.layoutSizingHorizontal !== "FIXED") continue;
    if (f === "height" && n.layoutSizingVertical && n.layoutSizingVertical !== "FIXED") continue;
    if ((f === "itemSpacing" || f === "counterAxisSpacing") && !autoLayout) continue;
    const v = n[f];
    if (f === "opacity") {
      if (typeof v === "number" && v !== 1) out[f] = v;
    } else if (typeof v === "number") {
      if (v !== 0) out[f] = v;
    } else if (v && typeof v === "object" && "value" in v && v.value !== 0) {
      out[f] = v; // lineHeight / letterSpacing
    }
  }

  for (const field of ["fills", "strokes"] as const) {
    const arr = n[field];
    if (!Array.isArray(arr)) continue;
    arr.forEach((p: Paint, i: number) => {
      if (p.type !== "SOLID" || p.visible === false) return;
      if (!boundProps.some((b) => b.startsWith(`${field}[${i}]`))) out[`${field}[${i}]`] = toHex(p.color, p.opacity);
    });
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------- variant diff ----------

async function variantDiff(params: BridgeRequest["params"]): Promise<VariantDiff> {
  if (!params.nodeId) throw new Error("nodeId is required.");
  let node: BaseNode | null = await figma.getNodeByIdAsync(params.nodeId.replace(/-/g, ":"));
  while (node && node.type !== "COMPONENT_SET") node = node.parent;
  if (!node) throw new Error("That node is not a component set or inside one.");
  const set = node as ComponentSetNode;

  const opts: WalkOpts = { maxDepth: Infinity, includeUnbound: true, includeVectors: false, includeIcons: false };
  const cache: VarCache = new Map();
  const registry = new Registry();
  tokenCache = new Map();
  const base = set.defaultVariant;

  const baseRun = await factsFor(base, opts, cache, registry);
  const reactionsOf = (nodes: NodeTokens[]) => reactionSummary(nodes[0]?.reactions as any[] | undefined);

  const filter = params.variantFilter?.toLowerCase();
  const variants: VariantDiff["variants"] = [];
  for (const child of set.children) {
    if (child.type !== "COMPONENT" || child.id === base.id) continue;
    if (filter && !child.name.toLowerCase().includes(filter)) continue;
    const run = await factsFor(child, opts, cache, registry);
    const reactions = reactionsOf(run.nodes);
    variants.push({
      nodeId: child.id,
      name: child.name,
      ...(reactions ? { reactions } : {}),
      changes: diffFacts(baseRun.facts, run.facts),
    });
  }

  const result: VariantDiff = {
    componentSet: set.name,
    componentSetId: set.id,
    properties: propertyDefinitions(set),
    tokens: registry.tokens,
    description: set.description ?? "",
    baseVariant: { nodeId: base.id, name: base.name, ...(reactionsOf(baseRun.nodes) ? { reactions: reactionsOf(baseRun.nodes) } : {}) },
    missingCombinations: missingCombinations(set),
    variants,
  };
  const links = (set.documentationLinks ?? []).map((l) => l.uri);
  if (links.length) result.documentationLinks = links;
  if (params.includeBase) result.base = { nodeCount: baseRun.nodes.length, nodes: baseRun.nodes };
  return result;
}

function coerce(v: unknown): unknown {
  return v === "true" ? true : v === "false" ? false : v;
}

/** Component property definitions: type, default, and (for variants) the allowed options. */
function propertyDefinitions(node: ComponentSetNode | ComponentNode): Record<string, PropertyDefinition> {
  const out: Record<string, PropertyDefinition> = {};
  let defs: ComponentPropertyDefinitions | undefined;
  try {
    defs = node.componentPropertyDefinitions;
  } catch {
    return out;
  }
  for (const [name, d] of Object.entries(defs ?? {})) {
    const def: PropertyDefinition = { type: d.type, default: coerce(d.defaultValue) };
    if (d.variantOptions) def.options = d.variantOptions.map(coerce);
    if (d.preferredValues?.length) def.preferred = d.preferredValues.map((p) => p.key);
    out[name] = def;
  }
  return out;
}

/** path (relative to the variant root, duplicate siblings numbered) + property -> value */
async function factsFor(root: ComponentNode, opts: WalkOpts, cache: VarCache, registry: Registry) {
  const flatByPath: { path: string; flat: FlatFact[] }[] = [];
  const nodes: NodeTokens[] = [];
  await walk(root, ROOT, 0, opts, cache, registry, nodes, flatByPath);

  const nameCount = new Map<string, number>();
  const facts = new Map<string, string>();
  for (const { path: rel, flat: list } of flatByPath) {
    const n = (nameCount.get(rel) ?? 0) + 1;
    nameCount.set(rel, n);
    const key = n > 1 ? `${rel}#${n}` : rel;
    for (const f of list) facts.set(`${key}\u0000${f.property}`, f.value);
  }
  return { facts, nodes };
}

/** Changes with the same property, base and new value are merged into one entry listing every path. */
function diffFacts(base: Map<string, string>, other: Map<string, string>): VariantChange[] {
  const grouped = new Map<string, VariantChange>();
  const keys = new Set([...base.keys(), ...other.keys()]);
  for (const k of keys) {
    const a = base.get(k) ?? "(none)";
    const b = other.get(k) ?? "(none)";
    if (a === b) continue;
    const [path, property] = k.split("\u0000");
    const gk = `${property}\u0000${a}\u0000${b}`;
    const g = grouped.get(gk);
    if (g) g.paths.push(path);
    else grouped.set(gk, { paths: [path], property, base: a, value: b });
  }
  return [...grouped.values()];
}

/** Variant-property combinations that are possible from the property values but have no variant in the set. */
function missingCombinations(set: ComponentSetNode): string[] {
  const variantDefs = Object.entries(set.componentPropertyDefinitions ?? {}).filter(([, d]) => d.type === "VARIANT");
  if (!variantDefs.length) return [];
  let combos: string[][] = [[]];
  for (const [n, d] of variantDefs) {
    combos = combos.flatMap((c) => (d.variantOptions ?? []).map((v) => [...c, `${n}=${v}`]));
  }
  const existing = new Set(
    set.children.map((c) =>
      c.name
        .split(",")
        .map((x) => x.trim())
        .sort()
        .join(", ")
    )
  );
  return combos.map((c) => c.sort().join(", ")).filter((c) => !existing.has(c)).slice(0, 100);
}

// ---------- variable resolution ----------

function getVar(id: string, cache: Map<string, Promise<Variable | null>>): Promise<Variable | null> {
  let p = cache.get(id);
  if (!p) {
    p = (async () => {
      try {
        const v = await figma.variables.getVariableByIdAsync(id);
        if (v) return v;
      } catch {}
      // Remote ids look like VariableID:<key>/<local id>; try importing by key.
      const m = /^VariableID:([^/]+)\//.exec(id);
      if (m) {
        try {
          return await figma.variables.importVariableByKeyAsync(m[1]);
        } catch {}
      }
      return null;
    })();
    cache.set(id, p);
  }
  return p;
}

const collectionCache = new Map<string, Promise<VariableCollection | null>>();
function getCollection(id: string) {
  let p = collectionCache.get(id);
  if (!p) {
    p = figma.variables.getVariableCollectionByIdAsync(id).catch(() => null);
    collectionCache.set(id, p);
  }
  return p;
}

async function activeValue(
  v: Variable,
  node: SceneNode,
  coll: VariableCollection | null,
  overrides?: Record<string, string>
) {
  const modes = (node as any).resolvedVariableModes as Record<string, string> | undefined;
  const modeId =
    overrides?.[v.variableCollectionId] ??
    modes?.[v.variableCollectionId] ??
    coll?.defaultModeId ??
    Object.keys(v.valuesByMode)[0];
  return v.valuesByMode[modeId];
}

async function link(v: Variable): Promise<ChainLink> {
  const coll = await getCollection(v.variableCollectionId);
  return { name: v.name, collection: coll?.name };
}

function cachedToken(id: string, node: SceneNode, cache: VarCache): Promise<TokenInfo | null> {
  const key = `${id}|${JSON.stringify((node as any).resolvedVariableModes ?? {})}`;
  let p = tokenCache.get(key);
  if (!p) {
    p = resolveToken(id, node, cache);
    tokenCache.set(key, p);
  }
  return p;
}

async function followChain(first: Variable, node: SceneNode, cache: VarCache, overrides?: Record<string, string>) {
  const chain: ChainLink[] = [await link(first)];
  const vars: Variable[] = [first];
  const seen = new Set<string>([first.id]);
  let cur: Variable = first;
  let curColl = await getCollection(first.variableCollectionId);
  let resolvedValue: unknown;
  let chainBrokenAt: string | undefined;
  for (let i = 0; i < MAX_CHAIN; i++) {
    const val = await activeValue(cur, node, curColl, overrides);
    if (!isAlias(val)) {
      resolvedValue = formatValue(val);
      break;
    }
    const next = await getVar(val.id, cache);
    if (!next) {
      chainBrokenAt = val.id;
      break;
    }
    if (seen.has(next.id)) {
      chainBrokenAt = `cycle at ${next.name}`;
      break;
    }
    seen.add(next.id);
    chain.push(await link(next));
    vars.push(next);
    cur = next;
    curColl = await getCollection(next.variableCollectionId);
  }
  return { chain, vars, resolvedValue, chainBrokenAt };
}

async function resolveToken(id: string, node: SceneNode, cache: VarCache): Promise<TokenInfo | null> {
  const first = await getVar(id, cache);
  if (!first) return null;
  const coll = await getCollection(first.variableCollectionId);

  // Follow the alias chain in the node's active modes.
  const { chain, vars, resolvedValue, chainBrokenAt } = await followChain(first, node, cache);

  // Per-mode values of the directly bound token (only worth showing when its collection has several modes).
  let modeValues: Record<string, unknown> | undefined;
  if (coll && coll.modes.length > 1) {
    modeValues = {};
    for (const m of coll.modes) {
      const val = first.valuesByMode[m.modeId];
      if (isAlias(val)) {
        const t = await getVar(val.id, cache);
        modeValues[m.name] = t ? `-> ${t.name}` : `-> (unresolved ${val.id})`;
      } else {
        modeValues[m.name] = formatValue(val);
      }
    }
  }

  // For each multi-mode collection along the chain, the final value in each of its modes
  // (every other collection held at its active mode), plus the modes that were active.
  const nodeModes = (node as any).resolvedVariableModes as Record<string, string> | undefined;
  const activeModes: Record<string, string> = {};
  const modeResolutions: Record<string, Record<string, unknown>> = {};
  const identical: string[] = [];
  const done = new Set<string>();
  for (const v of vars) {
    if (done.has(v.variableCollectionId)) continue;
    done.add(v.variableCollectionId);
    const c = await getCollection(v.variableCollectionId);
    if (!c || c.modes.length < 2) continue;
    const activeId = nodeModes?.[c.id] ?? c.defaultModeId;
    activeModes[c.name] = c.modes.find((m) => m.modeId === activeId)?.name ?? activeId;
    const byMode: Record<string, unknown> = {};
    for (const m of c.modes) {
      byMode[m.name] = (await followChain(first, node, cache, { [c.id]: m.modeId })).resolvedValue;
    }
    const vals = Object.values(byMode).map((x) => JSON.stringify(x));
    if (vals.every((x) => x === vals[0])) {
      // Modes exist but make no difference to this token: say so once, skip the per-mode data.
      identical.push(c.name);
      delete activeModes[c.name];
    } else {
      modeResolutions[c.name] = byMode;
    }
  }
  const multiMode = Object.keys(modeResolutions).length > 0;
  if (modeValues) {
    const mv = Object.values(modeValues).map((x) => JSON.stringify(x));
    if (mv.every((x) => x === mv[0])) modeValues = undefined;
  }

  return {
    id: first.id,
    name: first.name,
    collection: coll?.name,
    remote: first.remote,
    resolvedType: first.resolvedType,
    ...(modeValues ? { modeValues } : {}),
    chain,
    resolvedValue,
    ...(multiMode ? { activeModes, modeResolutions } : {}),
    ...(identical.length ? { modesIdentical: identical } : {}),
    chainBrokenAt,
  };
}

// ---------- list_variables ----------

async function listVariables(collection?: string, nameFilter?: string) {
  const colls = await figma.variables.getLocalVariableCollectionsAsync();
  const result: unknown[] = [];
  const f = nameFilter?.toLowerCase();
  for (const c of colls) {
    if (collection && c.name !== collection) continue;
    const vars: unknown[] = [];
    for (const id of c.variableIds) {
      const v = await figma.variables.getVariableByIdAsync(id);
      if (!v || (f && !v.name.toLowerCase().includes(f))) continue;
      const values: Record<string, unknown> = {};
      for (const m of c.modes) {
        const val = v.valuesByMode[m.modeId];
        if (isAlias(val)) {
          const t = await figma.variables.getVariableByIdAsync(val.id);
          values[m.name] = t ? `-> ${t.name}` : `-> (unresolved ${val.id})`;
        } else values[m.name] = formatValue(val);
      }
      vars.push({ id: v.id, name: v.name, type: v.resolvedType, values });
    }
    result.push({ collection: c.name, modes: c.modes.map((m) => m.name), variables: vars });
  }

  // Library collections are listed by name/key only; the Plugin API exposes no values for them.
  let library: unknown[] = [];
  try {
    const libs = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    library = libs
      .filter((l) => !collection || l.name === collection)
      .map((l) => ({ collection: l.name, library: l.libraryName, key: l.key }));
  } catch {}
  return { local: result, library };
}

// ---------- formatting ----------

function toHex(c: RGB | RGBA, opacity?: number): string {
  const h = (n: number) => Math.round(n * 255).toString(16).padStart(2, "0");
  const a = "a" in c ? c.a : opacity ?? 1;
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${a < 1 ? h(a) : ""}`;
}

function formatValue(v: VariableValue | undefined): unknown {
  if (v && typeof v === "object" && "r" in v) return toHex(v as RGBA);
  return v;
}

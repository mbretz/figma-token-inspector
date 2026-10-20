export type Action = "get_selection_tokens" | "get_node_tokens" | "list_variables" | "get_variant_diff";

export interface BridgeRequest {
  id: string;
  action: Action;
  params: {
    nodeIds?: string[];
    nodeId?: string;
    depth?: number;
    includeUnbound?: boolean;
    includeVectors?: boolean;
    includeIcons?: boolean;
    includeBase?: boolean;
    variantFilter?: string;
    collection?: string;
    nameFilter?: string;
  };
}

export interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** One hop in an alias chain, e.g. component/button/bg -> semantic/action/primary -> primitive/blue/500 */
export interface ChainLink {
  name: string;
  collection?: string;
}

export interface TokenInfo {
  /** Internal; stripped from output. */
  id?: string;
  name: string;
  collection?: string;
  /** Internal; converted to `local` in output. */
  remote?: boolean;
  /** True only for local (non-library) variables. */
  local?: boolean;
  resolvedType?: string;
  /** Mode name -> value for the bound token's own collection (alias targets shown as "-> token/name"). Only when that collection has several modes. */
  modeValues?: Record<string, unknown>;
  /** Multi-mode collections along the chain whose modes all resolve to the same final value (e.g. dark == light). */
  modesIdentical?: string[];
  /** Modes in effect for each collection along the chain. Only present when some collection in the chain has several modes. */
  activeModes?: Record<string, string>;
  /** For each multi-mode collection along the chain: mode name -> final resolved value (other collections held at their active mode). */
  modeResolutions?: Record<string, Record<string, unknown>>;
  /** Directly bound token first, then each alias hop down to the primitive. */
  chain: ChainLink[];
  /** Literal value in the node's active mode after following the chain. */
  resolvedValue?: unknown;
  /** Set when a hop could not be resolved. */
  chainBrokenAt?: string;
}

/** Properties that share one directly bound token on a node (e.g. paddingInline, cornerRadius). */
export interface Binding {
  properties: string[];
  /** Key into the response's top-level `tokens` dictionary. */
  token?: string;
  unresolvedAliasId?: string;
}

export interface NodeTokens {
  nodeId: string;
  name: string;
  type: string;
  path: string;
  /** Auto-layout and sizing structure. */
  layout?: Record<string, unknown>;
  /** Number of child layers (containers only). */
  childCount?: number;
  /** Number of those children that are hidden (only when > 0). */
  hiddenChildCount?: number;
  /** Position among its parent's children (left-to-right / top-to-bottom order). Not set on roots. */
  index?: number;
  /** Set (true) only when the layer is hidden. */
  hidden?: boolean;
  /** Component property references on this layer, e.g. {visible: "Show Label#86:4", characters: "Button Label#9:2"}. */
  propertyRefs?: Record<string, string>;
  /** Layer opacity (0-1). */
  opacity?: number;
  /** Dev Mode annotations on this layer. */
  annotations?: unknown[];
  /** Prototype reactions: triggers, actions and transitions. `transition: null` = instant. */
  reactions?: unknown[];
  /** Instance: main component + properties. Component: its variant properties. */
  component?: Record<string, unknown>;
  /** Text nodes: characters and non-token text styling. */
  text?: Record<string, unknown>;
  /** Effect types present (shadows, blurs). An empty array means the layer was read and has none. */
  effects?: string[];
  bindings: Binding[];
  /** Icons (includeIcons only): the instance's SVG markup. Fills are the exported literal colors, not tokens. */
  svg?: string;
  /** Hard-coded values with no variable bound (only when includeUnbound). */
  unboundValues?: Record<string, unknown>;
  /** Raw boundVariables keys, for debugging field shapes. */
  rawBoundKeys?: string[];
}

export interface TokenResult {
  nodeCount: number;
  /** Every distinct token referenced by `nodes`, keyed once, with full chain and mode values. */
  tokens: Record<string, TokenInfo>;
  nodes: NodeTokens[];
}

export interface VariantChange {
  /** Layer paths (relative to the variant root) sharing this exact change. */
  paths: string[];
  property: string;
  base: string;
  value: string;
}

export interface PropertyDefinition {
  type: string;
  default: unknown;
  /** VARIANT: the allowed values. */
  options?: unknown[];
  /** INSTANCE_SWAP: preferred component keys. */
  preferred?: string[];
}

export interface VariantDiff {
  componentSet: string;
  componentSetId: string;
  /** Always present; "" means read and empty. */
  description: string;
  documentationLinks?: string[];
  /** Every component property (variant, boolean, text, instance swap) with type, default and options. */
  properties: Record<string, PropertyDefinition>;
  /** Every token referenced by the base and the variants, with chains and mode resolutions. */
  tokens: Record<string, TokenInfo>;
  baseVariant: { nodeId: string; name: string; reactions?: string[] };
  /** Variant-property combinations with no variant in the set (e.g. hover+disabled). */
  missingCombinations: string[];
  /** Node details for the base (default) variant, only when includeBase is true. Tokens are in the top-level `tokens`. */
  base?: { nodeCount: number; nodes: NodeTokens[] };
  variants: { nodeId: string; name: string; reactions?: string[]; changes: VariantChange[] }[];
}

/** Known bindable scalar fields, used to report unbound literals. */
export const SCALAR_FIELDS = [
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingBottom",
  "itemSpacing",
  "counterAxisSpacing",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "opacity",
  "fontSize",
  "letterSpacing",
  "lineHeight",
  "paragraphSpacing",
] as const;

export const RADIUS_FIELDS = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"] as const;
export const STROKE_FIELDS = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"] as const;

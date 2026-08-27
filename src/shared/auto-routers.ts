/** The two routers, and what tells them apart. */
export const AUTO_ROUTERS = [
  { id: "openrouter/auto", label: "Auto", note: "The stable router." },
  { id: "openrouter/auto-beta", label: "Auto (beta)", note: "The newer one, still being tuned." },
] as const;

/** Whether this id is a router rather than a model. */
export function isAutoRouter(id: string): boolean {
  return AUTO_ROUTERS.some((router) => router.id === id);
}

/**
 * What a child tab should inherit from the parent's model, if anything.
 *
 * Auto mode is not a model choice, it is a standing decision to let
 * OpenRouter pick per request - so it is the one thing that should follow
 * into a tab the parent opens rather than be reset by the role. A parent
 * pinned to a model made a decision about itself, not a default for every
 * specialist it staffs, so that case sends nothing and the role decides.
 */
export function inheritedModel(parentModel: string | undefined): string | undefined {
  return parentModel !== undefined && isAutoRouter(parentModel) ? parentModel : undefined;
}

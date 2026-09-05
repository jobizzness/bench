import { Skeleton } from "./Skeleton.js";

/**
 * The unblock screen's shape while its decision is still on its way - the
 * title, the summary, the report frame and the options, sized like the real
 * ones so nothing moves when they land. Replaces the bare header the screen
 * used to draw for the length of that fetch (#80).
 */
export function UnblockSkeleton() {
  return (
    <>
      <Skeleton className="unblock-title-skeleton" width="70%" height="1.4em" />
      <Skeleton className="unblock-summary-skeleton" width="92%" height="1em" />
      <div id="unblock-report">
        <Skeleton className="frame-skeleton" />
      </div>
      <div className="unblock-options-skeleton">
        <Skeleton width="100%" height="46px" radius="10px" />
        <Skeleton width="100%" height="46px" radius="10px" />
      </div>
    </>
  );
}

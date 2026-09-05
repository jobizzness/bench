import { Skeleton } from "./Skeleton.js";

/** How much of a row's width each shape's name and quiet line take - varied
 * per row so three placeholders do not read as one row repeated. */
const ROWS = [
  { name: "72%", meta: "42%" },
  { name: "55%", meta: "58%" },
  { name: "64%", meta: "36%" },
];

/**
 * A few row shapes, standing in for whatever the roster has not told this
 * page about yet. Not grouped by project - there is no project to group by
 * until the first real roster arrives (see `Roster.tsx`).
 */
export function RosterSkeleton() {
  return (
    <>
      {ROWS.map(({ name, meta }, i) => (
        <li className="row-slot" key={i} aria-hidden="true">
          <div className="row skeleton-row">
            <div className="label"><Skeleton width={name} height="14px" /></div>
            <Skeleton width={meta} height="11px" />
          </div>
        </li>
      ))}
    </>
  );
}

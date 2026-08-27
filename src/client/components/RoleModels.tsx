import { useState } from "react";
import { modelLabel } from "../../shared/models.js";
import { ROLE_MODELS } from "../../shared/role-models.js";
import { ROLES, type Role } from "../../shared/roles.js";
import { ModelDialog } from "./ModelDialog.js";

/**
 * What each kind of work runs on.
 *
 * Every specialist used to open on Opus, whatever it was for - a researcher
 * reading docs was billed the same as a planner deciding what to build. The
 * role is the one thing Bench already knows about a tab before it has done
 * anything, so it is the thing that should choose.
 *
 * These are starting points, not rules: the model is still shown and still
 * changeable at the moment a specialist is made. What this settles is what it
 * is when nobody says otherwise, which is most of the time.
 */
export function RoleModels({ chosen = {}, onChange }: {
  /**
   * Only the roles the developer has overridden. Everything else follows the
   * built-in table, and follows it when that table changes.
   *
   * Optional because a daemon that predates the table sends no such field,
   * and a settings page that will not render is worse than one with nothing
   * overridden in it.
   */
  chosen?: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [editing, setEditing] = useState<Role | null>(null);

  return (
    <section id="s-roles">
      <label>Model per role</label>
      <p className="field-note" id="s-roles-note">
        What a new specialist starts on, by what it is for. Still changeable
        when you make one.
      </p>

      <ul id="s-role-list">
        {ROLES.map((role) => {
          const model = chosen[role] ?? ROLE_MODELS[role].preferred;
          return (
            <li className="s-role" key={role} data-role={role}>
              <span className="s-role-name">{role}</span>
              <button
                type="button"
                className="s-role-model"
                data-model={model}
                data-chosen={chosen[role] !== undefined}
                onClick={() => setEditing(role)}
              >
                {modelLabel(model)}
              </button>
              {/* Only where it differs from the built-in. A column of "reset"
                  buttons on rows nobody has touched is a column of noise. */}
              {chosen[role] !== undefined && (
                <button
                  type="button"
                  className="s-role-reset"
                  aria-label={`Put ${role} back to ${modelLabel(ROLE_MODELS[role].preferred)}`}
                  onClick={() => {
                    const next = { ...chosen };
                    delete next[role];
                    onChange(next);
                  }}
                >
                  reset
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {/* One dialog for six rows. Six mounted at once is six copies of a
          three-hundred-model list, and every one of them fetches. */}
      <ModelDialog
        id="s-role-dialog"
        standing
        open={editing !== null}
        current={editing === null ? "" : chosen[editing] ?? ROLE_MODELS[editing].preferred}
        onClose={() => setEditing(null)}
        onPick={(model) => {
          if (editing !== null) onChange({ ...chosen, [editing]: model });
        }}
      />
    </section>
  );
}

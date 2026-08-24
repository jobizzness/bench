import { projectName } from "../format.js";
import { showProject, useHiddenProjects } from "../hidden.js";

/**
 * The projects this browser is keeping out of the roster, and the way back.
 *
 * Hiding has to be reversible somewhere obvious, or it is a way to lose work
 * rather than a way to tidy. Settings is where the reversal lives because it
 * is the one place you can look when the roster is missing something and you
 * cannot remember what.
 */
export function HiddenProjects() {
  const hidden = useHiddenProjects();
  const projects = [...hidden].sort((a, b) => projectName(a).localeCompare(projectName(b)));

  return (
    <section id="s-hidden">
      <h3>Hidden projects</h3>

      {projects.length === 0 ? (
        <p className="field-note" id="s-hidden-none">
          None. Hover a project heading in the roster to hide it — its
          specialists keep working, and anything waiting on you still reaches
          the queue.
        </p>
      ) : (
        <>
          <ul id="s-hidden-list">
            {projects.map((project) => (
              <li key={project}>
                <span className="s-hidden-name" title={project}>{projectName(project)}</span>
                <button type="button" onClick={() => showProject(project)}>Show</button>
              </li>
            ))}
          </ul>
          <p className="field-note">
            Hidden in this browser only. The same bench read from another
            device shows all of them.
          </p>
        </>
      )}
    </section>
  );
}

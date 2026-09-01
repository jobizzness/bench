/**
 * The Firebase web config: an API key and a project id, public by design -
 * Firebase's own docs are explicit that these identify a project rather than
 * authenticate anything, and the security rules are what actually gate
 * access. Named once here so `bench-cockpit` is not typed in two places: the
 * client bundle imports it for `signInWithPopup`, and the daemon imports the
 * same values to call the Firestore and secure token REST APIs directly.
 *
 * The key is the real one for the `bench` web app on `bench-cockpit`, read
 * back from `firebase apps:sdkconfig WEB` rather than copied from a console
 * tab - a config for the wrong project is the one mistake here that is
 * expensive, because deploying this repo's rules replaces whatever ruleset
 * that project already had.
 */
export const FIREBASE_PROJECT_ID = "bench-cockpit";

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
}

// A literal, not read from the environment: this module is imported by the
// browser bundle as well as the daemon, and `process.env` does not exist
// there without a build-time --define for each variable it reads.
export const FIREBASE_WEB_CONFIG: FirebaseWebConfig = {
  apiKey: "AIzaSyDT-Dbp7hL4j_0kfjJwKE7wV3oORIG_38Q",
  authDomain: `${FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId: FIREBASE_PROJECT_ID,
};

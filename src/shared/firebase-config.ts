/**
 * The Firebase web config: an API key and a project id, public by design -
 * Firebase's own docs are explicit that these identify a project rather than
 * authenticate anything, and the security rules are what actually gate
 * access. Named once here so `bench-cockpit` is not typed in two places: the
 * client bundle imports it for `signInWithPopup`, and the daemon imports the
 * same values to call the Firestore and secure token REST APIs directly.
 *
 * `apiKey` is a placeholder. Filling it in requires a Web App registered
 * under the `bench-cockpit` Firebase project (console → Project settings →
 * Add app → Web), which this ticket deliberately does not do - creating and
 * configuring a live app in the developer's real Google Cloud project is a
 * one-way action outside what an implementer should do unattended. See the
 * report for this ticket for the exact steps left for the developer.
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
  apiKey: "REPLACE_WITH_FIREBASE_WEB_API_KEY",
  authDomain: `${FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId: FIREBASE_PROJECT_ID,
};

/** World Hub Package Protocol version implemented by this app. */
export const PROTOCOL_VERSION = 2;

/** Protocol versions this app can still read. */
export const READABLE_PROTOCOL_VERSIONS = [1, 2];

/**
 * World Hub Application Contract *format* version implemented by this app.
 *
 * This is the one a consumer gates compatibility on. It is deliberately not
 * called `CONTRACT_VERSION`: a contract record also has a revision counter
 * that climbs with every edit, and the two being near-homonyms led three of
 * four consumers to gate on the wrong one.
 */
export const CONTRACT_FORMAT_VERSION = 1;

/** Library descriptor format identifier. */
export const LIBRARY_FORMAT = 'world-hub-library';

/** Package manifest format identifier. */
export const PACKAGE_FORMAT = 'world-hub-package';

/** Contract format identifier. */
export const CONTRACT_FORMAT = 'world-hub-application-contract';

/** Minimum app version able to open libraries created by this app. */
export const MIN_COMPATIBLE_APP_VERSION = '1.0.0';

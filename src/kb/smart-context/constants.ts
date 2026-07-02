/**
 * Heuristic constants for Smart Context Retrieving.
 *
 * These values were chosen empirically and can be tuned via config.yaml
 * in future versions. They are centralized here to avoid magic numbers.
 */

// ── search.ts ──

/** Minimum path score for a candidate to trigger import graph extension (0–1). */
export const HIGH_PATH_CANDIDATE_THRESHOLD = 0.85;

/** Base boost added to BM25 score for recently-used session files. */
export const SESSION_BOOST_BASE = 0.15;

/** Decay factor applied per step of age in the session file list. */
export const SESSION_DECAY_PER_STEP = 0.8;

/** How many top-scoring files are used as starting nodes for graph walk. */
export const TOP_FILES_FOR_GRAPH_WALK = 5;

/** Score multiplier for graph-walk results when the file is NOT already in merged candidates. */
export const GRAPH_WALK_MISSING_IMPORT_MULTIPLIER = 0.5;

/** Score multiplier for graph-walk results when the file IS already in merged candidates. */
export const GRAPH_WALK_EXISTING_IMPORT_MULTIPLIER = 0.3;

/** LIMIT clause for the importers SQL query. */
export const IMPORTERS_QUERY_LIMIT = 200;

// ── ranker.ts ──

/** Multiplier used to compute hubMinDegree from total candidate count. */
export const HUB_MIN_DEGREE_MULTIPLIER = 0.05;

/** Penalty multiplier applied to barrel files (index.ts / index.js) with low path score. */
export const BARREL_PENALTY_MULTIPLIER = 0.5;

/** Path score threshold below which a barrel file receives the barrel penalty. */
export const BARREL_PATH_SCORE_THRESHOLD = 0.8;

// ── context-assembler.ts ──

/** Number of context lines above and below a matched line when extracting chunks. */
export const CONTEXT_LINES_AROUND_MATCH = 3;

/** Maximum file size (in bytes) allowed for skeletonization in buildSkeleton. */
export const MAX_SKELETON_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/** Number of fallback signature lines when no matched symbols are found in a Tier-2 file. */
export const FALLBACK_SIGS_COUNT = 10;

/** Maximum number of signature lines to include in Tier-2 skeleton output. */
export const MAX_SIGS_COUNT = 30;

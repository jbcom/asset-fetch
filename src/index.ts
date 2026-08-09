export { readItchApiKey } from "./apiKey.js";
export {
  classifyPack,
  dedupeByGame,
  fetchOwnedLibrary,
  sanitizeItchUrl,
  searchLibrary,
  type FetchLibraryOptions,
  type LibraryBucket,
  type OwnedPack,
  type SearchLibraryOptions,
} from "./library.js";
export {
  extractArchives,
  fetchItchAssets,
  slugify,
  type FetchAssetsOptions,
  type FetchAssetsResult,
  type ItchUpload,
  type PackToFetch,
} from "./fetch.js";
export {
  listExtractedAudioFiles,
  promoteAssets,
  writeAssetManifest,
  type AssetManifestEntry,
  type PromoteOptions,
  type PromoteResult,
  type PromoteSlot,
} from "./promote.js";

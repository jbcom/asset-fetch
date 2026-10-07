const assert = require("node:assert/strict");
const { sanitizeKey, slugify } = require("asset-fetch");

assert.equal(sanitizeKey("ambient-pad"), "ambient-pad");
assert.equal(slugify("Forest Ambience"), "forest-ambience");
console.log("CommonJS: asset keys and slugs verified");

import { searchLibrary } from "@jbdevprimary/asset-fetch";

const owned = [
  {
    keyId: 101,
    gameId: 202,
    title: "Forest Ambience",
    classification: "asset",
    shortText: "Looping wind and bird audio",
    url: "https://example.itch.io/forest-ambience",
  },
  {
    keyId: 102,
    gameId: 203,
    title: "Pixel Forest Tiles",
    classification: "asset",
    shortText: "A 16px terrain tileset",
    url: "https://example.itch.io/pixel-forest",
  },
];

for (const pack of searchLibrary(owned, { query: "forest", bucket: "audio" })) {
  console.log(pack.title);
}

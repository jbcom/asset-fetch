import { promoteAssets, writeAssetManifest } from "asset-fetch";

const [source, target = "public/assets/audio"] = process.argv.slice(2);
if (!source) {
  console.error("usage: node examples/promote-audio.mjs <source.wav> [target-directory] --apply");
  process.exitCode = 1;
} else {
  const apply = process.argv.includes("--apply");
  const result = promoteAssets({
    targetDir: target,
    apply,
    slots: [{ name: "ambient-pad", sources: [source] }],
  });
  if (apply) writeAssetManifest(target, result.manifest);
  console.log(JSON.stringify(result, null, 2));
}

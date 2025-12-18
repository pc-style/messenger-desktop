import { readFile } from "fs/promises";
import { join } from "path";
import HomeClient from "./HomeClient";

export default async function Home() {
  let version = "v1.0.0"; // Fallback
  
  try {
    // Path leads to the .version file at the root of the messenger-desktop repository
    const versionPath = join(process.cwd(), "..", ".version");
    const content = await readFile(versionPath, "utf-8");
    version = content.trim();
  } catch (error) {
    console.error("Failed to read .version file:", error);
    version = "Unknown Version";
  }

  return <HomeClient version={version} />;
}

import { stat, lstat, rename, symlink, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Ubuntu can restrict user namespaces for unpackaged Electron executables.
// Reuse an already-installed, root-owned Chromium helper without changing OS
// policy or running this installation as root. Never disable the sandbox.
if (process.platform === "linux") {
  const target = fileURLToPath(
    new URL("../node_modules/electron/dist/chrome-sandbox", import.meta.url),
  );
  const validHelper = async (file) => {
    try {
      const info = await stat(file);
      return (
        info.isFile() &&
        info.uid === 0 &&
        (info.mode & 0o4000) !== 0 &&
        (info.mode & 0o022) === 0
      );
    } catch {
      return false;
    }
  };
  if (!(await validHelper(target))) {
    let installed = false;
    for (const candidate of [
      "/opt/google/chrome/chrome-sandbox",
      "/usr/lib/chromium/chrome-sandbox",
      "/usr/lib/chromium-browser/chrome-sandbox",
    ]) {
      if (!(await validHelper(candidate))) continue;
      try {
        await lstat(target);
        const backup = `${target}.bundled`;
        try {
          await access(backup);
          continue;
        } catch {
          /* Backup does not exist. */
        }
        await rename(target, backup);
        try {
          await symlink(candidate, target);
        } catch (error) {
          await rename(backup, target);
          throw error;
        }
        console.log(
          `Electron will use the installed Linux sandbox helper: ${candidate}`,
        );
        installed = true;
        break;
      } catch (error) {
        console.warn(`Could not prepare Electron sandbox: ${error.message}`);
      }
    }
    if (!installed)
      console.log(
        "Electron will use its standard Linux sandbox setup. See README if your distribution restricts unprivileged user namespaces.",
      );
  }
}

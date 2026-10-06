import { homedir } from "os";
import { mkdir, readFile, writeFile } from "fs/promises";

type Settings = Record<string, unknown>;

function isJsonObject(value: unknown): value is Settings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a settings document, returning undefined when it is not a JSON
 * object. The parser's own exception is deliberately discarded: its message
 * can quote fragments of the document, and settings documents carry secrets.
 */
function parseSettingsObject(content: string): Settings | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Value-free description for logs: only top-level key names, never values.
 */
function describeKeys(settings: Settings): string {
  const keys = Object.keys(settings);
  if (keys.length === 0) {
    return "no top-level keys";
  }
  const noun = keys.length === 1 ? "key" : "keys";
  return `${keys.length} top-level ${noun}: ${keys.join(", ")}`;
}

/**
 * Only the error code (e.g. ENOENT) is reported: error messages embed the
 * offending "path", which for a malformed input is the input itself.
 */
function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "unknown error";
}

/**
 * A settings input that is not inline JSON is treated as a file path, but
 * only when it plausibly is one. Anything else (e.g. JSON missing its outer
 * braces) is most likely a malformed payload and must never be echoed as a
 * path.
 */
function looksLikeFilePath(input: string): boolean {
  return !/[\r\n"{}]/.test(input);
}

/**
 * Load the `settings` input, which is either an inline JSON object or the
 * path of a JSON file. Errors name the path and the failure kind only.
 */
async function loadSettingsInput(input: string): Promise<Settings> {
  if (input.startsWith("{")) {
    const parsed = parseSettingsObject(input);
    if (!parsed) {
      throw new Error(
        "Settings input looks like JSON but could not be parsed (expected a JSON object)",
      );
    }
    console.log(`Parsed settings input as JSON`);
    return parsed;
  }

  if (!looksLikeFilePath(input)) {
    throw new Error(
      "Settings input is neither a JSON object nor a file path (input not shown because it may contain secrets)",
    );
  }

  console.log(`Settings input is not JSON, treating as file path: ${input}`);
  let content: string;
  try {
    content = await readFile(input, "utf-8");
  } catch (readError) {
    throw new Error(
      `Settings file '${input}' could not be read (${errorCode(readError)})`,
    );
  }

  const parsed = parseSettingsObject(content);
  if (!parsed) {
    throw new Error(
      `Settings file '${input}' is not valid JSON (expected a JSON object)`,
    );
  }
  console.log(`Successfully read and parsed settings from file`);
  return parsed;
}

export async function setupClaudeCodeSettings(
  settingsInput?: string,
  homeDir?: string,
) {
  const home = homeDir ?? homedir();
  const settingsDir = `${home}/.claude`;
  const settingsPath = `${settingsDir}/settings.json`;
  console.log(`Setting up Claude settings at: ${settingsPath}`);

  // Ensure .claude directory exists
  console.log(`Creating .claude directory...`);
  await mkdir(settingsDir, { recursive: true });

  let settings: Settings = {};
  let existingContent: string | undefined;
  try {
    existingContent = await readFile(settingsPath, "utf-8");
  } catch (readError) {
    console.log(
      `No existing settings file found (${errorCode(readError)}), creating new one`,
    );
  }

  if (existingContent !== undefined) {
    if (!existingContent.trim()) {
      console.log(`Settings file exists but is empty`);
    } else {
      const existing = parseSettingsObject(existingContent);
      if (existing) {
        settings = existing;
        console.log(`Found existing settings with ${describeKeys(existing)}`);
      } else {
        // A corrupt settings file must not take the whole action down: the
        // file is rewritten below anyway, so fall back to a clean slate.
        console.warn(
          `Existing settings file at ${settingsPath} is not valid JSON (expected an object); starting from empty settings`,
        );
      }
    }
  }

  // Handle settings input (either inline JSON or a file path). Trimmed so a
  // YAML block scalar's trailing newline does not break a file path.
  const trimmedInput = settingsInput?.trim();
  if (trimmedInput) {
    console.log(`Processing settings input...`);
    const inputSettings = await loadSettingsInput(trimmedInput);

    // Input settings override existing settings of the same name
    settings = { ...settings, ...inputSettings };
    console.log(`Merged settings input with ${describeKeys(inputSettings)}`);
  }

  // Always set enableAllProjectMcpServers to true
  settings.enableAllProjectMcpServers = true;
  console.log(`Updated settings with enableAllProjectMcpServers: true`);

  // Write directly rather than through a shell so values containing quotes,
  // `$`, backticks or backslashes are stored verbatim.
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`Settings saved successfully`);
}

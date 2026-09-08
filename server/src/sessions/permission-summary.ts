/**
 * Build a human-friendly one-liner for a permission request. Used as the UI
 * summary so the user can decide at a glance.
 */
export function summarizePermission(
  toolName: string,
  input: Record<string, unknown>,
): { summary: string; blastRadius: string | null } {
  switch (toolName) {
    case "Bash": {
      const cmd = String((input.command as string | undefined) ?? "").trim();
      return {
        summary: `Run shell command`,
        blastRadius: cmd ? `$ ${cmd}` : null,
      };
    }
    case "Edit": {
      const path = String((input.file_path as string | undefined) ?? "");
      return {
        summary: `Edit file`,
        blastRadius: path || null,
      };
    }
    case "MultiEdit": {
      const path = String((input.file_path as string | undefined) ?? "");
      const edits = Array.isArray(input.edits) ? input.edits.length : 0;
      return {
        summary: `Edit ${edits} places in file`,
        blastRadius: path || null,
      };
    }
    case "Write": {
      const path = String((input.file_path as string | undefined) ?? "");
      const content = String((input.content as string | undefined) ?? "");
      return {
        summary: content ? `Overwrite file` : `Create file`,
        blastRadius: path || null,
      };
    }
    case "Read": {
      const path = String((input.file_path as string | undefined) ?? "");
      return {
        summary: `Read file`,
        blastRadius: path || null,
      };
    }
    case "Glob":
      return {
        summary: `Glob pattern`,
        blastRadius: String(input.pattern ?? "") || null,
      };
    case "Grep":
      return {
        summary: `Grep pattern`,
        blastRadius: String(input.pattern ?? "") || null,
      };
    case "WebFetch":
      return {
        summary: `Fetch URL`,
        blastRadius: String(input.url ?? "") || null,
      };
    case "WebSearch":
      return {
        summary: `Web search`,
        blastRadius: String(input.query ?? "") || null,
      };
    default:
      return { summary: `Use ${toolName}`, blastRadius: null };
  }
}

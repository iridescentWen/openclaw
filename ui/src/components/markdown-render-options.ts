type MarkdownCodeBlockChrome = "copy" | "none";
type MarkdownRenderMode = "document" | "message";
type MarkdownJsonCodeBlockCollapse = "auto" | "never";

export type MarkdownRenderOptions = {
  assistantTranscriptRoleHeaders?: boolean;
  codeBlockChrome?: MarkdownCodeBlockChrome;
  fileLinks?: boolean;
  interactiveImages?: boolean;
  mode?: MarkdownRenderMode;
  jsonCodeBlockCollapse?: MarkdownJsonCodeBlockCollapse;
};

export type MarkdownRenderEnv = Required<MarkdownRenderOptions>;

export function normalizeMarkdownRenderOptions(
  options: MarkdownRenderOptions = {},
): MarkdownRenderEnv {
  return {
    assistantTranscriptRoleHeaders: options.assistantTranscriptRoleHeaders ?? false,
    codeBlockChrome: options.codeBlockChrome ?? "copy",
    fileLinks: options.fileLinks ?? false,
    interactiveImages: options.interactiveImages ?? false,
    mode: options.mode ?? "message",
    jsonCodeBlockCollapse: options.jsonCodeBlockCollapse ?? "auto",
  };
}

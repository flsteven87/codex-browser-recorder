export const PUBLIC_TEXT_PATHS = Object.freeze(
  [
    "README.md",
    "PRIVACY.md",
    "TERMS.md",
    "SUPPORT.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "CHANGELOG.md",
    "docs/architecture.md",
    "docs/troubleshooting.md",
    ".github/CODEOWNERS",
    ".github/dependabot.yml",
    ".github/pull_request_template.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
  ].toSorted(),
);

export const PUBLIC_MARKDOWN_PATHS = Object.freeze(
  PUBLIC_TEXT_PATHS.filter((relativePath) => relativePath.endsWith(".md")),
);

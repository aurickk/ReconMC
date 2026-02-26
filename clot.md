# Agent MCP Tool Usage Guidelines

This document instructs AI agents to proactively use available MCP (Model Context Protocol) tools. **Always use these tools when the situation calls for them without waiting for explicit permission.**

---

## Web Search & Documentation

### `kindly-web-search` / `firecrawl_search`
**Use when:**
- You need current information from the web
- Debugging errors by searching exact error messages
- Checking package versions, release notes, or migration guides
- Finding GitHub issues, StackOverflow threads, or documentation

### `firecrawl_scrape`
**Use when:**
- You have a specific URL and need its full content
- Extracting structured data from a specific page

### `firecrawl_map`
**Use when:**
- Discovering URLs on a documentation site
- Finding specific pages within large documentation sites

### `firecrawl_agent`
**Use when:**
- Complex multi-source research tasks
- JavaScript-heavy pages that fail with regular scraping

---

## Library/API Documentation (Context7)

### `firecrawl-mcp_resolve-library-id` + `firecrawl-mcp_query-docs`
**Use when:**
- You need up-to-date documentation for any library or framework
- You need to check API signatures, interfaces, or breaking changes
- You need code examples for a specific library
- You're implementing a feature using a library you're not 100% familiar with

**Always use this BEFORE writing code with unfamiliar APIs.**

---

## Astro Framework

### `Astro_docs_search_astro_docs`
**Use when:**
- Working with Astro framework
- Need Astro-specific patterns, configurations, or API references

---

## GitHub Integration

### Repository Operations
- `github_get_file_contents` - Read files from any GitHub repo
- `github_create_or_update_file` - Create/update files remotely
- `github_create_branch` - Create branches
- `github_create_pull_request` - Open PRs
- `github_push_files` - Push multiple files in one commit

### Issues & PRs
- `github_list_issues` / `github_issue_read` / `github_issue_write`
- `github_list_pull_requests` / `github_pull_request_read`
- `github_search_issues` / `github_search_pull_requests`
- `github_add_issue_comment` / `github_add_comment_to_pending_review`

### Search
- `github_search_code` - Search code across ALL GitHub repos
- `github_search_repositories` - Find repos by name, topic, etc.
- `github_search_users` - Find GitHub users

### Copilot Integration
- `github_create_pull_request_with_copilot` - Delegate implementation to Copilot
- `github_assign_copilot_to_issue` - Assign Copilot to work on an issue
- `github_get_copilot_job_status` - Check Copilot agent progress

**Use when:**
- Working with GitHub repositories
- Creating or reviewing PRs
- Searching for code patterns across the ecosystem
- Need to delegate implementation tasks to Copilot

---

## Minecraft Modding

### `mcmodding_search_fabric_docs`
**Use when:**
- Implementing Fabric mod features
- Need Fabric-specific tutorials or API references

### `mcmodding_get_example`
**Use when:**
- You need complete, working code examples for Minecraft modding
- Implementing items, blocks, entities, networking, etc.

### `mcmodding_search_mappings` / `mcmodding_get_class_details`
**Use when:**
- You need Minecraft class/method/field names (deobfuscated)
- Understanding Minecraft internals
- Debugging crash logs with obfuscated names

### `mcmodding_lookup_obfuscated`
**Use when:**
- You encounter obfuscated names (e.g., `m_46859_`, `f_46443_`) in crash logs

---

## Shadcn UI Components

### `shadcn_get_project_registries` / `shadcn_list_items_in_registries`
**Use when:**
- Setting up or checking shadcn configuration

### `shadcn_search_items_in_registries` / `shadcn_view_items_in_registries`
**Use when:**
- Looking for UI components to add
- Checking component APIs and props

### `shadcn_get_item_examples_from_registries`
**Use when:**
- You need usage examples and demos with full code
- Looking for implementation patterns

### `shadcn_get_add_command_for_items`
**Use when:**
- Ready to add components to the project

**Use when:**
- Building or modifying Vue/React UI components
- Need pre-built, accessible UI components
- Looking for component examples and patterns

---

## Decision Flow

```
Need information from the web?
├── Know the specific URL? → firecrawl_scrape
├── Need to find the right page? → firecrawl_map or firecrawl_search
└── Open-ended research? → kindly-web-search or firecrawl_agent

Working with a library/framework?
├── Astro? → Astro_docs_search_astro_docs
├── Any other library? → firecrawl-mcp_resolve-library-id → firecrawl-mcp_query-docs
└── Minecraft modding? → mcmodding_* tools

Working with GitHub?
├── Read/write files? → github_get_file_contents / github_create_or_update_file
├── Create PR? → github_create_pull_request or github_create_pull_request_with_copilot
├── Search code? → github_search_code
└── Issues/PRs? → github_*_issues / github_*_pull_requests

Building UI components?
└── shadcn_* tools for Vue/React components
```

---

## Important Reminders

1. **Be proactive** - Use these tools without being asked
2. **Prefer documentation tools** over guessing API signatures
3. **Use web search** for debugging errors and finding current best practices
4. **Use GitHub tools** for any repository operations instead of bash git commands when appropriate
5. **Use specialized tools** (Astro, Minecraft, Shadcn) for their respective domains
6. **Chain tools appropriately** - e.g., resolve library ID before querying docs

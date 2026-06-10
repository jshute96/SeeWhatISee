---
name: see-what-i-see
description: Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and describe what you see.
---
Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and make it available as context so the user can ask questions about what they see.

This runs through the **`see-what-i-see` MCP server**, which exposes the extension's captures as MCP tools (`get_latest`) and `seewhatisee://` resources. The steps below call those — your client must have that MCP server configured.

You can't run this autonomously since it requires the user to have just clicked the extension. Only run it when asked to.

## Steps

1. Call the `get_latest` tool. It returns a JSON metadata block describing one capture record, plus a `resource_link` for each saved file.
  - If the call fails, the SeeWhatISee Chrome extension probably hasn't taken any captures yet.

2. [[mcp-record.template.md]]

3. [[process.template.md]]

4. **Reading the referenced files:** each file is a resource you fetch only when you need it. Read it with `resources/read` on the `uri` from its `resource_link`, or with your client's native file-read tool at the `file://` path.

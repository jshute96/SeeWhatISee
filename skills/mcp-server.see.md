---
name: see-what-i-see
description: Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and describe what you see.
---
Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and make it available as context so the user can ask questions about what they see.

You can't run this autonomously since it requires the user to have just clicked the extension. Only run it when asked to.

## Steps

1. Call the `get_latest` tool. It returns a JSON metadata block describing one capture record, plus a `resource_link` for each saved file.
  - If the call fails, the SeeWhatISee Chrome extension probably hasn't taken any captures yet.
  - In the metadata, each of `screenshot`, `contents`, and `selection` carries a `uri` (a `file://` location) and `mimeType` instead of a path. The matching `resource_link` points at the same `uri`.

2. [[json-record.template.md]]

3. [[process.template.md]]

4. **Reading the referenced files:** each file is a resource you fetch only when you need it.
  - Read it with `resources/read` on its `uri`, or with your client's native file-read tool at the `file://` path.
  - Or call `get_latest` again with `return_inline: true` to get the bytes inline — images come back as image content you can view directly; HTML, markdown, and selections come back as embedded file resources.
  - Prefer not to pull large HTML in until you know what you're looking for.

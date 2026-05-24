---
name: see-what-i-see
description: Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and describe what you see.
---
Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension and make it available as context so the user can ask questions about what they see.

You can't run this autonomously since it requires the user to have just clicked the extension. Only run it when asked to.

## Steps

1. Call the `get_latest` tool. It returns one JSON record.
  - If the call fails, the SeeWhatISee Chrome extension probably hasn't taken any captures yet.
  - The record has absolute paths already filled in for `screenshot`, `contents`, and `selection`.

2. [[json-record.template.md]]

3. [[process.template.md]]

4. **Reading the referenced files:** Use your client's native file-read tool when you have one. Otherwise call `read_file` to fetch the bytes. Use `get_file_info` if you want to check size first. Both take the absolute path from the record.

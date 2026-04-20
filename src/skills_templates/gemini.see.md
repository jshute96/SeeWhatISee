description = """
Read the latest screenshot or HTML snapshot taken by the SeeWhatISee Chrome extension.

You can't run this autonomously since it requires the user to have just clicked the extension. Only run it when asked to.
"""
prompt = """
**If anything fails, do not try to debug or fix anything. Just report the failure.**

1. Read this JSON object:
!{$HOME/.gemini/scripts/copy-last-snapshot.sh}

2. [[json-record.template.md]]

3. [[process.template.md]]
"""

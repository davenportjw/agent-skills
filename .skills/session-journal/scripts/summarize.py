#!/usr/bin/env python3
import os
import re
import sys
import argparse
from datetime import datetime

def parse_frontmatter(content):
    match = re.match(r'^---\s*\n(.*?)\n---\s*\n', content, re.DOTALL)
    if not match:
        return {}, content
    
    fm_text = match.group(1)
    body = content[match.end():]
    
    metadata = {}
    current_key = None
    for line in fm_text.split('\n'):
        line_strip = line.strip()
        if not line_strip:
            continue
        
        if line.startswith('  -') or line.startswith(' -') or line_strip.startswith('-'):
            val = line_strip.lstrip('-').strip().strip('"').strip("'")
            if current_key:
                if not isinstance(metadata[current_key], list):
                    metadata[current_key] = []
                metadata[current_key].append(val)
        elif ':' in line:
            key, val = line.split(':', 1)
            key = key.strip()
            val = val.strip()
            current_key = key
            
            if val == '' or val == '|':
                metadata[key] = []
            elif val.startswith('[') and val.endswith(']'):
                metadata[key] = [item.strip().strip('"').strip("'") for item in val[1:-1].split(',') if item.strip()]
            else:
                metadata[key] = val.strip('"').strip("'")
    return metadata, body

def ensure_gitignore(workspace_dir):
    gitignore_path = os.path.join(workspace_dir, '.gitignore')
    ignore_rule = '.local/'
    
    if not os.path.exists(gitignore_path):
        print(f"Creating .gitignore at {gitignore_path}")
        with open(gitignore_path, 'w') as f:
            f.write(f"# Local settings and Session Journal\n{ignore_rule}\n")
        return
    
    with open(gitignore_path, 'r') as f:
        content = f.read()
    
    # Check if already ignored
    patterns = [
        r'^\.local/?$',
        r'^\.local/\*$'
    ]
    
    ignored = False
    for line in content.split('\n'):
        line_clean = line.strip()
        if line_clean.startswith('#') or not line_clean:
            continue
        for pattern in patterns:
            if re.match(pattern, line_clean):
                ignored = True
                break
        if ignored:
            break
            
    if not ignored:
        print(f"Appending ignore rule to {gitignore_path}")
        with open(gitignore_path, 'a') as f:
            f.write(f"\n# Local settings and Session Journal\n{ignore_rule}\n")

def generate_executive_summary(workspace_dir):
    sessions_dir = os.path.join(workspace_dir, '.local', 'sessions')
    if not os.path.exists(sessions_dir):
        print(f"Sessions directory does not exist at {sessions_dir}")
        return
    
    session_files = [f for f in os.listdir(sessions_dir) if f.startswith('session_') and f.endswith('.md')]
    
    sessions_data = []
    for file_name in session_files:
        file_path = os.path.join(sessions_dir, file_name)
        with open(file_path, 'r') as f:
            content = f.read()
        
        metadata, body = parse_frontmatter(content)
        metadata['filename'] = file_name
        # Ensure defaults
        metadata['id'] = metadata.get('id', file_name.replace('session_', '').replace('.md', ''))
        metadata['title'] = metadata.get('title', f"Session {metadata['id']}")
        metadata['date'] = metadata.get('date', datetime.fromtimestamp(os.path.getctime(file_path)).strftime('%Y-%m-%d'))
        metadata['status'] = metadata.get('status', 'Completed')
        metadata['summary'] = metadata.get('summary', 'No summary provided.')
        metadata['challenges'] = metadata.get('challenges', [])
        metadata['content_ideas'] = metadata.get('content_ideas', [])
        
        sessions_data.append(metadata)
    
    # Sort by date (newest first), then by ID
    sessions_data.sort(key=lambda x: (x.get('date', ''), x.get('id', '')), reverse=True)
    
    # Generate markdown
    summary_path = os.path.join(sessions_dir, 'SESSION-INDEX.md')
    
    custom_themes = "*No cross-session themes or multi-session content ideas have been consolidated yet. You can document long-running development themes, multi-session bug hunts, or overarching architectural shifts inside these HTML comment blocks to preserve them across updates.*"
    active_threads = "- Ongoing work that spans multiple sessions"
    
    if os.path.exists(summary_path):
        with open(summary_path, 'r') as f:
            old_content = f.read()
        
        theme_match = re.search(r'<!-- START_CUSTOM_THEMES -->\s*(.*?)\s*<!-- END_CUSTOM_THEMES -->', old_content, re.DOTALL)
        if theme_match and theme_match.group(1).strip():
            custom_themes = theme_match.group(1).strip()
            
        threads_match = re.search(r'<!-- START_ACTIVE_THREADS -->\s*(.*?)\s*<!-- END_ACTIVE_THREADS -->', old_content, re.DOTALL)
        if threads_match and threads_match.group(1).strip():
            active_threads = threads_match.group(1).strip()
    
    # Count metrics
    total_sessions = len(sessions_data)
    completed_sessions = sum(1 for s in sessions_data if s.get('status', '').lower() == 'completed')
    in_progress_sessions = total_sessions - completed_sessions
    
    md = []
    md.append("# Session Journal Index")
    md.append("")
    md.append(f"*(Auto-generated from individual session journals. Last updated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} local time)*")
    md.append("")
    
    # Key stats/metrics
    md.append("## 📊 Quick Stats")
    md.append("")
    md.append(f"| Metric | Count |")
    md.append(f"| :--- | :--- |")
    md.append(f"| 📅 **Total Sessions** | {total_sessions} |")
    md.append(f"| ✅ **Completed Sessions** | {completed_sessions} |")
    md.append(f"| 🔄 **Active/In-Progress** | {in_progress_sessions} |")
    md.append("")
    
    # Session Directory Table
    md.append("## 🗂️ Session Directory")
    md.append("")
    md.append("| Date | Session ID | Title / Focus | Status | Key Accomplishment / Summary |")
    md.append("| :--- | :--- | :--- | :--- | :--- |")
    for s in sessions_data:
        status_icon = "✅" if s.get('status', '').lower() == 'completed' else "🔄"
        session_link = f"[{s['id']}]({s['filename']})"
        md.append(f"| {s['date']} | {session_link} | **{s['title']}** | {status_icon} {s['status']} | {s['summary']} |")
    md.append("")
    
    # Active Threads Section
    md.append("## 🔄 Active Threads")
    md.append("")
    md.append("<!-- START_ACTIVE_THREADS -->")
    md.append(active_threads)
    md.append("<!-- END_ACTIVE_THREADS -->")
    md.append("")
    
    # Aggregated Challenges
    md.append("## ⚠️ Key Technical Challenges & Solutions")
    md.append("")
    md.append("Here is a consolidated list of key obstacles encountered during development, serving as an internal knowledge base for this repository:")
    md.append("")
    has_challenges = False
    for s in sessions_data:
        if s.get('challenges'):
            has_challenges = True
            md.append(f"### [{s['title']}]({s['filename']})")
            for challenge in s['challenges']:
                md.append(f"- {challenge}")
            md.append("")
    if not has_challenges:
        md.append("*No challenges logged yet.*")
        md.append("")
        
    # Public Content Roadmap
    md.append("## 🚀 Public Content Opportunities & Roadmap")
    md.append("")
    md.append("The following topics were identified as highly relevant for educational blogs, deep-dive videos, or open-source code snippets:")
    md.append("")
    
    has_ideas = False
    for s in sessions_data:
        if s.get('content_ideas'):
            has_ideas = True
            md.append(f"### [{s['title']}]({s['filename']})")
            for idea in s['content_ideas']:
                md.append(f"- {idea}")
            md.append("")
    if not has_ideas:
        md.append("*No content opportunities identified yet.*")
        md.append("")
        
    # Cross-session Themes Section
    md.append("## 🎯 Multi-Session Themes & Consolidated Content")
    md.append("")
    md.append("Here you can document overarching architectural shifts, long-running bug hunts, or development themes that span multiple individual sessions:")
    md.append("")
    md.append("<!-- START_CUSTOM_THEMES -->")
    md.append(custom_themes)
    md.append("<!-- END_CUSTOM_THEMES -->")
    md.append("")
    
    md.append("---")
    md.append("*To contribute or log a new session, create a file `.local/sessions/session_<id>.md` with YAML frontmatter and run the summarizer script.*")
    
    with open(summary_path, 'w') as f:
        f.write('\n'.join(md))
    
    print(f"Session Journal Index successfully generated/updated at {summary_path}")

def main():
    parser = argparse.ArgumentParser(description="Compile session journal summaries and update .gitignore.")
    parser.add_argument("--workspace", required=True, help="Path to the active workspace/repository.")
    parser.add_argument("--conv-id", required=True, help="Current Active Conversation ID.")
    
    args = parser.parse_args()
    
    workspace_dir = os.path.abspath(args.workspace)
    if not os.path.exists(workspace_dir):
        print(f"Error: Workspace directory '{workspace_dir}' does not exist.")
        sys.exit(1)
        
    # Create sessions folder if missing
    sessions_dir = os.path.join(workspace_dir, '.local', 'sessions')
    os.makedirs(sessions_dir, exist_ok=True)
    
    # Ensure gitignore contains .local/
    ensure_gitignore(workspace_dir)
    
    # Regenerate executive summary
    generate_executive_summary(workspace_dir)

if __name__ == '__main__':
    main()

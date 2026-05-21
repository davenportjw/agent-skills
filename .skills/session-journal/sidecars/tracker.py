#!/usr/bin/env python3
import os
import re
import sys
import json
import time
from datetime import datetime

BRAIN_DIR = os.environ.get("ANTIGRAVITY_BRAIN_DIR", os.path.expanduser("~/.antigravity/brain"))

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
        with open(gitignore_path, 'w') as f:
            f.write(f"# Local settings and Session Journal\n{ignore_rule}\n")
        return
    
    with open(gitignore_path, 'r') as f:
        content = f.read()
    
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
        with open(gitignore_path, 'a') as f:
            f.write(f"\n# Local settings and Session Journal\n{ignore_rule}\n")

def detect_workspace(transcript_lines):
    # Scan lines for file paths inside GitHub directory
    for line_str in transcript_lines:
        try:
            data = json.loads(line_str)
            content = data.get('content', '')
            # Check tool_calls for Cwd or TargetFile
            for tc in data.get('tool_calls', []):
                args = tc.get('Arguments', {})
                # Check standard locations
                for key in ['Cwd', 'TargetFile', 'AbsolutePath', 'SearchPath', 'NotebookPath']:
                    path_val = args.get(key)
                    if path_val and isinstance(path_val, str) and '/Users/jasondavenport/GitHub/' in path_val:
                        match = re.match(r'^(/Users/jasondavenport/GitHub/[^/]+)', path_val)
                        if match:
                            return match.group(1)
            
            # Scan raw content
            match = re.search(r'/Users/jasondavenport/GitHub/([^/\s\n\)"\']+)', content)
            if match:
                return f"/Users/jasondavenport/GitHub/{match.group(1)}"
        except Exception:
            continue
    return None

def parse_transcript_to_session(transcript_path):
    with open(transcript_path, 'r') as f:
        lines = f.readlines()
    
    if not lines:
        return None, None
    
    workspace = detect_workspace(lines)
    if not workspace:
        return None, None
    
    steps = []
    modified_files = set()
    challenges = []
    objective = "Not specified."
    first_user_input = True
    
    for line_str in lines:
        try:
            step = json.loads(line_str)
            step_idx = step.get('step_index', 0)
            step_type = step.get('type', '')
            content = step.get('content', '')
            
            # Capture primary objective
            if step_type == 'USER_INPUT' and first_user_input:
                first_user_input = False
                # Clean up metadata additions
                req_match = re.search(r'<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>', content, re.DOTALL)
                if req_match:
                    objective = req_match.group(1).strip()
                else:
                    objective = content.strip().split('\n')[0]
            
            # Capture tool calls & modified files
            tool_calls = step.get('tool_calls', [])
            for tc in tool_calls:
                tool_name = tc.get('name', '')
                args = tc.get('args', tc.get('Arguments', {}))
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        pass
                
                # Log changes
                if tool_name in ['write_to_file', 'replace_file_content', 'multi_replace_file_content']:
                    tgt = args.get('TargetFile')
                    if tgt:
                        modified_files.add(os.path.basename(tgt))
                
                steps.append(f"Step {step_idx}: Executed `{tool_name}` tool")
            
            # Capture errors as challenges
            if step.get('status') == 'ERROR':
                challenges.append(f"Step {step_idx} error: {content[:200]}...")
                
        except Exception as e:
            continue
            
    # Format title from objective
    title_words = objective.replace('\n', ' ').split(' ')
    title = ' '.join([w for w in title_words if w][:6])
    if len(title_words) > 6:
        title += "..."
        
    # Simple heuristic for content ideas
    content_ideas = []
    if modified_files:
        content_ideas.append(f"Blog: Deep dive into modifying {', '.join(list(modified_files)[:2])}")
    if challenges:
        content_ideas.append("Blog: Troubleshooting and resolving runtime/linter errors")
        
    session_summary = {
        "title": title,
        "objective": objective,
        "modified_files": list(modified_files),
        "challenges": challenges if challenges else ["No major errors encountered."],
        "content_ideas": content_ideas if content_ideas else ["Design patterns and architecture walkthrough."],
        "steps": steps
    }
    
    return workspace, session_summary

def update_session_files(workspace_dir, conv_id, summary_data):
    sessions_dir = os.path.join(workspace_dir, '.local', 'sessions')
    os.makedirs(sessions_dir, exist_ok=True)
    
    session_file = os.path.join(sessions_dir, f"session_{conv_id}.md")
    
    # Preserve existing user comments/manual edits if file already exists
    existing_content = ""
    if os.path.exists(session_file):
        with open(session_file, 'r') as f:
            existing_content = f.read()
            
    metadata, body = parse_frontmatter(existing_content)
    
    title = metadata.get('title', summary_data['title'])
    date_str = metadata.get('date', datetime.now().strftime('%Y-%m-%d'))
    status = metadata.get('status', 'In-Progress')
    brief_summary = metadata.get('summary', f"Active session focused on: {summary_data['title']}")
    
    # Union list items
    challenges = list(set(metadata.get('challenges', []) + summary_data['challenges']))
    content_ideas = list(set(metadata.get('content_ideas', []) + summary_data['content_ideas']))
    
    md = []
    md.append("---")
    md.append(f'id: "{conv_id}"')
    md.append(f'title: "{title}"')
    md.append(f'date: "{date_str}"')
    md.append(f'status: "{status}"')
    md.append(f'summary: "{brief_summary}"')
    md.append("challenges:")
    for c in challenges:
        md.append(f"  - \"{c}\"")
    md.append("content_ideas:")
    for ci in content_ideas:
        md.append(f"  - \"{ci}\"")
    md.append("---")
    md.append("")
    md.append(f"# 📓 Session Journal: {title}")
    md.append("")
    md.append("## 🎯 Objective / Focus")
    md.append(summary_data['objective'])
    md.append("")
    md.append("## 🗺️ Key Chronology & Steps")
    md.append("")
    for step in summary_data['steps']:
        md.append(f"- {step}")
    md.append("")
    md.append("## 🔧 Modified Files")
    md.append("")
    if summary_data['modified_files']:
        for f_name in summary_data['modified_files']:
            md.append(f"- `{f_name}`")
    else:
        md.append("*No files modified yet.*")
    md.append("")
    
    with open(session_file, 'w') as f:
        f.write('\n'.join(md))

def generate_executive_summary(workspace_dir):
    sessions_dir = os.path.join(workspace_dir, '.local', 'sessions')
    session_files = [f for f in os.listdir(sessions_dir) if f.startswith('session_') and f.endswith('.md')]
    
    sessions_data = []
    for file_name in session_files:
        file_path = os.path.join(sessions_dir, file_name)
        with open(file_path, 'r') as f:
            content = f.read()
        
        metadata, body = parse_frontmatter(content)
        metadata['filename'] = file_name
        metadata['id'] = metadata.get('id', file_name.replace('session_', '').replace('.md', ''))
        metadata['title'] = metadata.get('title', f"Session {metadata['id']}")
        metadata['date'] = metadata.get('date', datetime.fromtimestamp(os.path.getctime(file_path)).strftime('%Y-%m-%d'))
        metadata['status'] = metadata.get('status', 'Completed')
        metadata['summary'] = metadata.get('summary', 'No summary provided.')
        metadata['challenges'] = metadata.get('challenges', [])
        metadata['content_ideas'] = metadata.get('content_ideas', [])
        
        sessions_data.append(metadata)
    
    sessions_data.sort(key=lambda x: (x.get('date', ''), x.get('id', '')), reverse=True)
    
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
            
    total_sessions = len(sessions_data)
    completed_sessions = sum(1 for s in sessions_data if s.get('status', '').lower() == 'completed')
    in_progress_sessions = total_sessions - completed_sessions
    
    md = []
    md.append("# Session Journal Index")
    md.append("")
    md.append(f"*(Auto-generated from background daemon. Last updated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} local time)*")
    md.append("")
    md.append("## 📊 Quick Stats")
    md.append("")
    md.append(f"| Metric | Count |")
    md.append(f"| :--- | :--- |")
    md.append(f"| 📅 **Total Sessions** | {total_sessions} |")
    md.append(f"| ✅ **Completed Sessions** | {completed_sessions} |")
    md.append(f"| 🔄 **Active/In-Progress** | {in_progress_sessions} |")
    md.append("")
    md.append("## 🗂️ Session Directory")
    md.append("")
    md.append("| Date | Session ID | Title / Focus | Status | Key Accomplishment / Summary |")
    md.append("| :--- | :--- | :--- | :--- | :--- |")
    for s in sessions_data:
        status_icon = "✅" if s.get('status', '').lower() == 'completed' else "🔄"
        session_link = f"[{s['id']}]({s['filename']})"
        md.append(f"| {s['date']} | {session_link} | **{s['title']}** | {status_icon} {s['status']} | {s['summary']} |")
    md.append("")
    
    md.append("## 🔄 Active Threads")
    md.append("")
    md.append("<!-- START_ACTIVE_THREADS -->")
    md.append(active_threads)
    md.append("<!-- END_ACTIVE_THREADS -->")
    md.append("")
    
    md.append("## ⚠️ Key Technical Challenges & Solutions")
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
        
    md.append("## 🚀 Public Content Opportunities & Roadmap")
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
        
    md.append("## 🎯 Multi-Session Themes & Consolidated Content")
    md.append("")
    md.append("<!-- START_CUSTOM_THEMES -->")
    md.append(custom_themes)
    md.append("<!-- END_CUSTOM_THEMES -->")
    md.append("")
    
    md.append("---")
    
    with open(summary_path, 'w') as f:
        f.write('\n'.join(md))

def main():
    print("Antigravity Session Journal Tracker Daemon started.")
    sys.stdout.flush()
    
    processed_states = {}
    
    while True:
        try:
            if not os.path.exists(BRAIN_DIR):
                time.sleep(5)
                continue
                
            # Find active conversations
            convs = [d for d in os.listdir(BRAIN_DIR) if os.path.isdir(os.path.join(BRAIN_DIR, d))]
            for conv_id in convs:
                transcript_path = os.path.join(BRAIN_DIR, conv_id, '.system_generated', 'logs', 'transcript.jsonl')
                if not os.path.exists(transcript_path):
                    continue
                    
                mtime = os.path.getmtime(transcript_path)
                size = os.path.getsize(transcript_path)
                
                state_key = f"{conv_id}:{mtime}:{size}"
                if processed_states.get(conv_id) == state_key:
                    continue
                    
                # File has changed, re-parse it
                workspace_dir, summary_data = parse_transcript_to_session(transcript_path)
                if workspace_dir and os.path.exists(workspace_dir) and summary_data:
                    ensure_gitignore(workspace_dir)
                    update_session_files(workspace_dir, conv_id, summary_data)
                    generate_executive_summary(workspace_dir)
                    print(f"Updated session {conv_id} for workspace {workspace_dir}")
                    sys.stdout.flush()
                    
                processed_states[conv_id] = state_key
                
        except Exception as e:
            print(f"Error in tracking loop: {e}")
            sys.stdout.flush()
            
        time.sleep(5)

if __name__ == '__main__':
    main()

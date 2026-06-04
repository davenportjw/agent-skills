#!/usr/bin/env python3
import json
import subprocess
import sys
import argparse
from collections import defaultdict

def run_cmd(cmd):
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        print(f"Error running {' '.join(cmd)}: {result.stderr}", file=sys.stderr)
        return None
    return result.stdout

def get_image_creation_date(reference):
    # Try inspect to get exact creation date
    output = run_cmd(["container", "image", "inspect", reference])
    if not output:
        return None
    try:
        data = json.loads(output)
        if not data:
            return None
        item = data[0]
        
        # Check index annotations first
        if "index" in item and "annotations" in item["index"]:
            created = item["index"]["annotations"].get("org.opencontainers.image.created")
            if created:
                return created
                
        # Check variants
        if "variants" in item and len(item["variants"]) > 0:
            config = item["variants"][0].get("config", {})
            created = config.get("created")
            if created:
                return created
                
    except Exception as e:
        print(f"Error parsing inspect data for {reference}: {e}", file=sys.stderr)
    return None

def main():
    parser = argparse.ArgumentParser(description="Find the latest version of container images and delete prior revisions.")
    parser.add_argument("image_name", nargs="?", help="Name of the image repository (e.g. 'docs', 'ai-service'). If not provided, cleans up all images.")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be deleted without actually deleting")
    args = parser.parse_args()

    target_name = args.image_name
    
    print(f"Fetching images...")
    output = run_cmd(["container", "image", "list", "--format", "json"])
    if not output:
        sys.exit(1)
        
    try:
        images = json.loads(output)
    except Exception as e:
        print(f"Error parsing image list: {e}", file=sys.stderr)
        sys.exit(1)

    grouped_images = defaultdict(list)
    
    for img in images:
        ref = img.get("reference")
        if not ref:
            continue
            
        # ref could be docker.io/library/docs:latest, docs:v1, etc.
        # split off the tag
        repo = ref.split(":")[0] if ":" in ref else ref
        
        # Match if the repo name is exactly the target or ends with /target
        if target_name and repo != target_name and not repo.endswith(f"/{target_name}"):
            continue

        created_str = None
        # check if created date is in list output
        if "descriptor" in img and "annotations" in img["descriptor"]:
            created_str = img["descriptor"]["annotations"].get("org.opencontainers.image.created")
            
        if not created_str:
            created_str = get_image_creation_date(ref)
            
        # Treat None as very old
        grouped_images[repo].append({
            "reference": ref,
            "created": created_str or "1970-01-01T00:00:00Z"
        })
            
    if not grouped_images:
        if target_name:
            print(f"No images found matching '{target_name}'.")
        else:
            print("No images found.")
        sys.exit(0)

    all_to_delete = []

    for repo, matched_images in grouped_images.items():
        # Sort descending by creation date (latest first)
        matched_images.sort(key=lambda x: x["created"], reverse=True)
        
        print(f"\nFound {len(matched_images)} versions of '{repo}':")
        for i, img in enumerate(matched_images):
            marker = " (LATEST - KEEP)" if i == 0 else " (OLD - DELETE)"
            print(f"  - {img['reference']} [Created: {img['created']}]{marker}")
            
        if len(matched_images) > 1:
            all_to_delete.extend(matched_images[1:])

    if not all_to_delete:
        print("\nNo prior revisions found to delete.")
        sys.exit(0)
        
    if args.dry_run:
        print(f"\nDRY RUN mode. Would delete {len(all_to_delete)} images:")
        for img in all_to_delete:
            print(f"  {img['reference']}")
        sys.exit(0)
        
    print(f"\nDeleting {len(all_to_delete)} prior revisions...")
    for img in all_to_delete:
        ref = img['reference']
        print(f"Deleting {ref}...")
        run_cmd(["container", "image", "rm", ref])
        
    print("Cleanup complete.")

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Audit and fix ckassets/maps/ so every file satisfies:
  - Name:  {cols}x{rows}_{CamelCaseTags}.webp  (no spaces in tags)
  - Size:  cols*70 x rows*70 pixels exactly

Run with --dry-run to preview changes without writing anything.

Rules for resolving mismatches:
  * If actual pixel dims ARE exact multiples of 70, trust them as the
    authoritative cell count and fix the filename accordingly.
  * If actual pixel dims are NOT exact multiples of 70, trust the
    filename cell count and resize to cols*70 x rows*70.
"""
import os, re, subprocess, sys

MAPS_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '../../ckassets/maps')
)
TARGET   = 70
DRY_RUN  = '--dry-run' in sys.argv

def get_dims(path):
    out = subprocess.check_output(
        ['identify', '-format', '%w %h', path],
        stderr=subprocess.DEVNULL
    ).decode().split()
    return int(out[0]), int(out[1])

def resize_webp(src, dst, w, h):
    """High-quality resize using Lanczos; writes WebP quality 90."""
    subprocess.check_call([
        'convert', src,
        '-filter', 'Lanczos',
        '-resize', f'{w}x{h}!',
        '-define', 'webp:lossless=false',
        '-quality', '90',
        dst
    ], stderr=subprocess.DEVNULL)

def main():
    if DRY_RUN:
        print('=== DRY RUN — no files will be changed ===\n')

    files = sorted(
        f for f in os.listdir(MAPS_DIR)
        if f.lower().endswith('.webp') and not f.startswith('.')
    )

    ok = skipped = 0
    actions = []  # list of (old_path, new_path, resize_to) tuples

    for fname in files:
        path = os.path.join(MAPS_DIR, fname)
        m = re.match(r'^(\d+)x(\d+)_(.+)\.webp$', fname)
        if not m:
            print(f'  SKIP (unexpected name format): {fname}')
            skipped += 1
            continue

        named_cols = int(m.group(1))
        named_rows = int(m.group(2))
        tags       = m.group(3)
        clean_tags = re.sub(r'\s+', '', tags)   # remove any spaces from tag section

        w, h = get_dims(path)

        # Authoritative cell count
        if w % TARGET == 0 and h % TARGET == 0:
            actual_cols = w // TARGET
            actual_rows = h // TARGET
        else:
            # Wrong cell size — use filename as authoritative source
            actual_cols = named_cols
            actual_rows = named_rows

        exp_w        = actual_cols * TARGET
        exp_h        = actual_rows * TARGET
        correct_name = f'{actual_cols}x{actual_rows}_{clean_tags}.webp'
        correct_path = os.path.join(MAPS_DIR, correct_name)

        needs_rename = correct_name != fname
        needs_resize = (w != exp_w or h != exp_h)

        if not needs_rename and not needs_resize:
            ok += 1
            continue

        resize_note = f'  resize  {w}×{h} → {exp_w}×{exp_h}' if needs_resize else ''
        rename_note = f'  rename  {fname}\n       →  {correct_name}' if needs_rename else ''
        print(f'{"[DRY] " if DRY_RUN else ""}FIX: {fname}')
        if rename_note: print(rename_note)
        if resize_note: print(resize_note)

        # Flag large upscales that may reduce perceived quality
        if needs_resize and exp_w > w * 1.2:
            scale = exp_w / w
            print(f'  NOTE: {scale:.2f}× upscale — original was authored at non-70px cell size')

        if correct_path != path and os.path.exists(correct_path):
            print(f'  ERROR: target already exists — skipping to avoid overwrite')
            skipped += 1
            continue

        actions.append((path, correct_path, (exp_w, exp_h) if needs_resize else None))
        print()

    if not DRY_RUN:
        for old_path, new_path, resize_dims in actions:
            tmp = old_path + '.__tmp__.webp'
            src = old_path

            if resize_dims:
                resize_webp(src, tmp, *resize_dims)
                src = tmp

            if new_path != old_path:
                os.rename(src, new_path)
                # If we created a tmp and the original is still on disk, remove it
                if src != old_path and os.path.exists(old_path):
                    os.remove(old_path)
            else:
                # Same filename, just overwrite with resized version
                os.rename(src, old_path)

            if os.path.exists(tmp):
                os.remove(tmp)

    print(f'{"(dry run) " if DRY_RUN else ""}Results: {ok} already correct, '
          f'{len(actions)} {"would be" if DRY_RUN else ""} fixed, {skipped} skipped')

if __name__ == '__main__':
    main()

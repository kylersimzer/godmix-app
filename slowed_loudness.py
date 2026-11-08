"""Keep an album's slowed versions in the same perceived-loudness relationship as its masters.
Measures each master and its Slowed + Reverb with the ISO 532-1 hearing model (phons), takes the typical
master->slowed difference across the album, and nudges any slowed version that strays by > 0.4 phon
(about 1 dB per phon here) via its per-song target_offset.
Usage: python slowed_loudness.py --album 000 [--apply]   (then re-render the songs it lists)"""
import os, sys
import numpy as np
import mlib, perceived_loudness as pl, albums
import versions as V

VER = "Slowed + Reverb"


def phon_of(path):
    x, fs = mlib.load(path)
    return pl.perceived(x, fs)[0]


if __name__ == "__main__":
    from concurrent.futures import ProcessPoolExecutor
    aid = sys.argv[sys.argv.index("--album") + 1] if "--album" in sys.argv else albums.default_id()
    a = albums.album(aid)
    tracks = [t for t in a["tracks"] if VER in V.album_cfg(aid)["tracks"].get(t["title"], []) and os.path.exists(V.version_path(a, t, VER))]
    with ProcessPoolExecutor(4) as ex:
        ph = list(ex.map(phon_of, [t["master"] for t in tracks] + [V.version_path(a, t, VER) for t in tracks]))
    master, slowed = ph[: len(tracks)], ph[len(tracks):]
    k = float(np.median(np.array(slowed) - np.array(master)))
    print(f"album {aid}: typical master -> slowed difference {k:+.1f} phon\n")
    changes = {}
    for t, mp, sp in zip(tracks, master, slowed):
        adj = round((mp + k) - sp, 1)
        flag = abs(adj) > 0.4
        print(f"{t['title'][:28]:28s} master {mp:5.1f}  slowed {sp:5.1f}  ({sp - mp:+.1f})  -> {'adjust ' + format(adj, '+.1f') + ' dB' if flag else 'ok'}")
        if flag:
            changes[t["title"]] = adj
    if "--apply" in sys.argv and changes:
        cfg = V.album_cfg(aid)
        for title, adj in changes.items():
            o = cfg["overrides"].setdefault(title, {}).setdefault(VER, {})
            o["target_offset"] = round(V.recipe_for(aid, title, VER).get("target_offset", 0.0) + adj, 1)
        V.save_vcfg()
        print("\napplied; re-render:", " ".join(str(albums.track(a, t)["n"]) for t in changes))

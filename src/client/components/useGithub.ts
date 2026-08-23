import { useEffect, useState } from "react";
import { authFetch } from "../api.js";

export interface GithubItem {
  number: number;
  title: string;
  url: string;
  kind: "issue" | "pull";
  state: string;
  updatedAt: string;
  author: string;
  draft?: boolean;
}

export interface GithubList {
  slug: string | null;
  items: GithubItem[];
  loading: boolean;
}

const NOTHING: GithubList = { slug: null, items: [], loading: false };

/**
 * The project's recent issues and pull requests, fetched when the drawer is
 * opened rather than kept warm.
 *
 * Nobody has this open while they work - it is a thing you reach for - so
 * polling it would spend a GitHub request a second on a panel nobody is
 * looking at. The daemon holds a short cache, which is what makes opening it
 * twice in a row cheap.
 */
export function useGithub(sessionId: string | null, open: boolean): GithubList {
  const [list, setList] = useState<GithubList>(NOTHING);

  useEffect(() => {
    if (!open || !sessionId) return;

    let live = true;
    setList((current) => ({ ...current, loading: true }));

    void (async () => {
      const res = await authFetch(`/api/sessions/${sessionId}/github`);
      if (!live) return;
      if (!res.ok) { setList(NOTHING); return; }
      const body = await res.json();
      setList({ slug: body.slug ?? null, items: body.items ?? [], loading: false });
    })();

    return () => { live = false; };
  }, [sessionId, open]);

  return list;
}

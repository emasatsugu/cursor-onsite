/**
 * Hard-coded workspace remote for all VMs (POC).
 * Repo: https://github.com/emasatsugu/cursor-onsite-test
 *
 * Prefer HTTPS + GITHUB_TOKEN for non-interactive push from the VM process.
 * SSH (`git@github.com:...`) also works if the machine has working ssh-agent keys.
 */
export const WORKSPACE_GIT_REMOTE =
  "https://github.com/emasatsugu/cursor-onsite-test.git";

/** Build a remote URL, embedding a token when present so push works non-interactively. */
export function remoteUrlWithAuth(
  remote: string = WORKSPACE_GIT_REMOTE,
  token: string | undefined = process.env.GITHUB_TOKEN,
): string {
  if (!token?.trim()) return remote;
  // Token auth only applies to HTTPS remotes.
  if (!remote.startsWith("http://") && !remote.startsWith("https://")) {
    return remote;
  }
  try {
    const u = new URL(remote);
    u.username = "x-access-token";
    u.password = token.trim();
    return u.toString();
  } catch {
    return remote;
  }
}

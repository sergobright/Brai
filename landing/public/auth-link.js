(function () {
  const links = document.querySelectorAll("[data-auth-link]");
  if (!links.length) return;

  fetch("https://app.brai.one/api/auth/session", {
    credentials: "include",
    cache: "no-store",
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((session) => {
      if (!session || session.authenticated !== true) return;
      for (const link of links) link.textContent = "APP";
    })
    .catch(() => {});
})();

// Resolve the actual release assets instead of guessing installer filenames.
fetch('https://api.github.com/repos/bennix/FigFactory/releases/latest')
  .then(response => { if (!response.ok) throw new Error('Release not available'); return response.json(); })
  .then(release => {
    document.querySelector('#version').textContent = release.tag_name;
    const patterns = { 'mac-arm64': /mac-arm64\.dmg$/, 'mac-x64': /mac-x64\.dmg$/, 'win-x64': /win-x64\.exe$/, 'linux-deb': /linux-(?:x64|amd64)\.deb$/, 'linux-rpm': /linux-(?:x64|x86_64)\.rpm$/ };
    for (const link of document.querySelectorAll('[data-platform]')) {
      const asset = release.assets.find(asset => patterns[link.dataset.platform].test(asset.name));
      if (asset) link.href = asset.browser_download_url;
      else { link.href = release.html_url; link.querySelector('b').textContent = '↗'; link.title = '查看此版本的构建与下载状态'; }
    }
  }).catch(() => {});

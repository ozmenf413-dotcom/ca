try {
    if (localStorage.getItem('yt_theme') === 'dark') {
        document.documentElement.classList.add('yt-dark');
    }
} catch (e) {}

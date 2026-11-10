(function() {
    var _countdownTimer = null;

    window._loginWarningAccepted = false;

    window._showLoginWarning = function(onAccept) {
        var modal = document.getElementById('loginWarningModal');
        var acceptBtn = document.getElementById('loginWarningAccept');
        var cancelBtn = document.getElementById('loginWarningCancel');
        var countdownEl = document.getElementById('loginWarningCountdown');
        var btnTextEl = document.getElementById('loginWarningBtnText');

        modal.style.display = '';
        modal.classList.add('active');
        acceptBtn.disabled = true;
        cancelBtn.disabled = true;
        acceptBtn.style.opacity = '0.4';
        acceptBtn.style.cursor = 'not-allowed';
        cancelBtn.style.opacity = '0.4';
        cancelBtn.style.cursor = 'not-allowed';

        var remaining = 5;
        countdownEl.textContent = remaining;
        btnTextEl.textContent = 'Anladım ve Kabul Ediyorum (' + remaining + ')';

        if (_countdownTimer) clearInterval(_countdownTimer);
        _countdownTimer = setInterval(function() {
            remaining--;
            if (remaining > 0) {
                countdownEl.textContent = remaining;
                btnTextEl.textContent = 'Anladım ve Kabul Ediyorum (' + remaining + ')';
            } else {
                clearInterval(_countdownTimer);
                _countdownTimer = null;
                countdownEl.textContent = '0';
                btnTextEl.textContent = 'Anladım ve Kabul Ediyorum';
                acceptBtn.disabled = false;
                cancelBtn.disabled = false;
                acceptBtn.style.opacity = '1';
                acceptBtn.style.cursor = 'pointer';
                cancelBtn.style.opacity = '1';
                cancelBtn.style.cursor = 'pointer';
            }
        }, 1000);

        acceptBtn.onclick = function() {
            if (acceptBtn.disabled) return;
            _closeWarning(modal);
            if (typeof onAccept === 'function') {
                setTimeout(onAccept, 300);
            }
        };

        cancelBtn.onclick = function() {
            if (cancelBtn.disabled) return;
            _closeWarning(modal);
        };
    };

    function _closeWarning(modal) {
        if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
        modal.classList.remove('active');
    }
})();

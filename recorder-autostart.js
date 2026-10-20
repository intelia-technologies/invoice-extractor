// Auto-start recorder in every frame during active recording.
// Injected via chrome.scripting.registerContentScripts with allFrames: true.
// The recorder.js must already be registered too.
(function() {
  // Wait for recorder to be available (it's injected as a separate script)
  let attempts = 0;
  const tryStart = () => {
    if (window.__invoiceRecorder) {
      if (!window.__invoiceRecorder.getStatus()?.isRecording) {
        window.__invoiceRecorder.start();
      }
    } else if (attempts < 20) {
      attempts++;
      setTimeout(tryStart, 100);
    }
  };
  tryStart();
})();

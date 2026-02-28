import { useState, useRef, useCallback, useEffect } from 'react';

function negotiateMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
        'audio/webm;codecs=opus',
        'audio/mp4',
        'audio/webm',
    ];
    for (const mime of candidates) {
        if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return '';
}

/**
 * Voice recorder hook.
 *
 * State machine: idle → requesting → recording ⇄ paused → idle
 *                                   ↘ error → idle
 *
 * Exposes getAmplitude() and getDuration() as on-demand readers (no state updates)
 * so the consuming component can poll at its own cadence without causing re-renders.
 */
export function useVoiceRecorder() {
    const [state, setState] = useState('idle');
    const [error, setError] = useState(null);

    const mediaRecorderRef = useRef(null);
    const streamRef = useRef(null);
    const audioContextRef = useRef(null);
    const analyserRef = useRef(null);
    const dataArrayRef = useRef(null);
    const chunksRef = useRef([]);
    const resolveStopRef = useRef(null);
    const mimeTypeRef = useRef('');
    const startTimeRef = useRef(0);
    const totalPausedMsRef = useRef(0);
    const pauseStartRef = useRef(0);

    const cleanup = useCallback(() => {
        if (mediaRecorderRef.current) {
            try {
                if (mediaRecorderRef.current.state !== 'inactive') {
                    mediaRecorderRef.current.stop();
                }
            } catch { /* no-op */ }
            mediaRecorderRef.current = null;
        }
        if (audioContextRef.current) {
            try { audioContextRef.current.close(); } catch { /* no-op */ }
            audioContextRef.current = null;
            analyserRef.current = null;
            dataArrayRef.current = null;
        }
        if (streamRef.current) {
            for (const track of streamRef.current.getTracks()) track.stop();
            streamRef.current = null;
        }
        chunksRef.current = [];
        totalPausedMsRef.current = 0;
        pauseStartRef.current = 0;
        startTimeRef.current = 0;
    }, []);

    useEffect(() => cleanup, [cleanup]);

    /** Returns current RMS amplitude (0–1). Reads directly from the AnalyserNode. */
    const getAmplitude = useCallback(() => {
        const analyser = analyserRef.current;
        const dataArray = dataArrayRef.current;
        if (!analyser || !dataArray) return 0;

        analyser.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            const v = (dataArray[i] - 128) / 128;
            sum += v * v;
        }
        return Math.sqrt(sum / dataArray.length);
    }, []);

    /** Returns elapsed recording time in seconds (excludes paused time). */
    const getDuration = useCallback(() => {
        if (startTimeRef.current === 0) return 0;
        const extraPaused = pauseStartRef.current > 0
            && mediaRecorderRef.current?.state === 'paused'
            ? Date.now() - pauseStartRef.current
            : 0;
        return Math.max(0, (Date.now() - startTimeRef.current - totalPausedMsRef.current - extraPaused) / 1000);
    }, []);

    const startRecording = useCallback(async () => {
        if (state === 'recording' || state === 'requesting' || state === 'paused') return;

        setState('requesting');
        setError(null);
        chunksRef.current = [];
        totalPausedMsRef.current = 0;
        pauseStartRef.current = 0;

        if (!navigator.mediaDevices?.getUserMedia) {
            setState('error');
            setError('Your browser does not support audio recording.');
            return;
        }

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });
        } catch (err) {
            setState('error');
            if (err.name === 'NotAllowedError') {
                setError('Microphone access was denied. Please allow microphone access in your browser settings.');
            } else if (err.name === 'NotFoundError') {
                setError('No microphone found. Please connect a microphone and try again.');
            } else {
                setError('Could not access microphone.');
            }
            return;
        }

        streamRef.current = stream;

        // Web Audio analyser for amplitude
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            audioContextRef.current = audioContext;
            const source = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            analyserRef.current = analyser;
            dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);
        } catch {
            // Waveform won't work but recording can proceed
        }

        // MediaRecorder
        const mimeType = negotiateMimeType();
        mimeTypeRef.current = mimeType;

        let recorder;
        try {
            const options = mimeType
                ? { mimeType, audioBitsPerSecond: 128000 }
                : { audioBitsPerSecond: 128000 };
            recorder = new MediaRecorder(stream, options);
        } catch {
            try {
                recorder = mimeType
                    ? new MediaRecorder(stream, { mimeType })
                    : new MediaRecorder(stream);
            } catch {
                cleanup();
                setState('error');
                setError('Could not start recording.');
                return;
            }
        }

        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
                chunksRef.current.push(e.data);
            }
        };

        recorder.onstop = () => {
            const chunks = chunksRef.current;
            const actualMime = mimeTypeRef.current || 'audio/webm';
            const blob = new Blob(chunks, { type: actualMime });
            const finalDuration = startTimeRef.current > 0
                ? (Date.now() - startTimeRef.current - totalPausedMsRef.current) / 1000
                : 0;

            if (resolveStopRef.current) {
                resolveStopRef.current({ blob, mimeType: actualMime, duration: finalDuration });
                resolveStopRef.current = null;
            }
        };

        mediaRecorderRef.current = recorder;
        recorder.start(250);
        startTimeRef.current = Date.now();
        setState('recording');
    }, [state, cleanup]);

    const pauseRecording = useCallback(() => {
        const recorder = mediaRecorderRef.current;
        if (!recorder || recorder.state !== 'recording') return;
        recorder.pause();
        pauseStartRef.current = Date.now();
        setState('paused');
    }, []);

    const resumeRecording = useCallback(() => {
        const recorder = mediaRecorderRef.current;
        if (!recorder || recorder.state !== 'paused') return;
        totalPausedMsRef.current += Date.now() - pauseStartRef.current;
        pauseStartRef.current = 0;
        recorder.resume();
        setState('recording');
    }, []);

    const stopRecording = useCallback(() => {
        return new Promise((resolve) => {
            const recorder = mediaRecorderRef.current;
            if (!recorder || recorder.state === 'inactive') {
                resolve(null);
                cleanup();
                setState('idle');
                return;
            }

            // Account for any ongoing pause
            if (recorder.state === 'paused') {
                totalPausedMsRef.current += Date.now() - pauseStartRef.current;
                pauseStartRef.current = 0;
            }

            resolveStopRef.current = (result) => {
                // Clean up stream + audio context
                if (audioContextRef.current) {
                    try { audioContextRef.current.close(); } catch { /* no-op */ }
                    audioContextRef.current = null;
                    analyserRef.current = null;
                    dataArrayRef.current = null;
                }
                if (streamRef.current) {
                    for (const track of streamRef.current.getTracks()) track.stop();
                    streamRef.current = null;
                }
                mediaRecorderRef.current = null;
                chunksRef.current = [];
                startTimeRef.current = 0;
                totalPausedMsRef.current = 0;
                setState('idle');
                resolve(result);
            };

            recorder.stop();
        });
    }, [cleanup]);

    const cancelRecording = useCallback(() => {
        resolveStopRef.current = null;
        cleanup();
        setState('idle');
    }, [cleanup]);

    return {
        state,
        error,
        getAmplitude,
        getDuration,
        startRecording,
        stopRecording,
        cancelRecording,
        pauseRecording,
        resumeRecording,
    };
}


import React, { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
  stream: MediaStream | null;
  isRecording: boolean;
}

const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ stream, isRecording }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // 1. Handle High-DPI (Retina) screens for sharp rendering
    const setupCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      // Get the CSS size of the canvas container
      const rect = canvas.getBoundingClientRect();
      
      // Set the internal resolution matches the physical pixels
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      
      const ctx = canvas.getContext('2d');
      if (ctx) {
         // Scale drawing operations so coordinates match CSS pixels
         ctx.scale(dpr, dpr);
      }
    };

    // Initial setup
    setupCanvas();

    // Handle resizing (e.g. if window size changes)
    const resizeObserver = new ResizeObserver(() => {
       setupCanvas();
    });
    resizeObserver.observe(canvas);

    if (!stream || !isRecording) {
        return () => {
            resizeObserver.disconnect();
            cancelAnimationFrame(animationRef.current);
        }
    }

    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    
    analyserRef.current = analyser;
    sourceRef.current = source;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const ctx = canvas.getContext('2d');

    if (!ctx) return;

    const draw = () => {
      if (!isRecording) return;
      
      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      // Use logic dimensions for clearing
      const width = canvas.width / (window.devicePixelRatio || 1);
      const height = canvas.height / (window.devicePixelRatio || 1);

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = 'rgb(248, 250, 252)'; // matches bg-slate-50
      ctx.fillRect(0, 0, width, height);

      const barWidth = (width / bufferLength) * 2.5;
      let barHeight;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        // Normalize height to canvas height
        barHeight = (dataArray[i] / 255) * height;
        
        // Create gradient
        const gradient = ctx.createLinearGradient(0, height, 0, 0);
        gradient.addColorStop(0, '#3b82f6'); // blue-500
        gradient.addColorStop(1, '#93c5fd'); // blue-300

        ctx.fillStyle = gradient;
        
        // Rounded top bars
        ctx.beginPath();
        // roundRect is standard in modern browsers
        if (ctx.roundRect) {
            ctx.roundRect(x, height - barHeight, barWidth, barHeight, [2, 2, 0, 0]);
        } else {
            ctx.rect(x, height - barHeight, barWidth, barHeight);
        }
        ctx.fill();

        x += barWidth + 2;
      }
    };

    draw();

    return () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(animationRef.current);
      if (sourceRef.current) sourceRef.current.disconnect();
      if (analyserRef.current) analyserRef.current.disconnect();
      if (audioContext.state !== 'closed') audioContext.close();
    };
  }, [stream, isRecording]);

  return (
    <canvas 
      ref={canvasRef} 
      className="w-full h-full block"
      style={{ width: '100%', height: '100%' }}
    />
  );
};

export default AudioVisualizer;

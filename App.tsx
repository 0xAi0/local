import React, { useState, useEffect, useRef } from 'react';
import { Shield, Lock, Smartphone, Monitor, Link as LinkIcon, Check, Copy, AlertCircle, Terminal, Wifi } from 'lucide-react';
import * as Security from './lib/security';
import * as LinkUtil from './lib/link';

// --- TYPES ---
interface Message {
  id: string;
  text: string;
  sender: 'me' | 'peer';
  timestamp: number;
}

enum State {
  INIT,
  HOST_GENERATING,
  HOST_WAITING, // Showing Link/QR
  GUEST_PROCESSING, // Processing Link
  GUEST_ANSWER_READY, // Guest shows Answer QR
  CONNECTED
}

declare const QRCode: any; // From CDN

export default function App() {
  const [state, setState] = useState<State>(State.INIT);
  const [sharedKey, setSharedKey] = useState<CryptoKey | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  
  // WebRTC Refs
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  
  // Connection Data
  const [offerLink, setOfferLink] = useState('');
  const [answerData, setAnswerData] = useState('');
  const [manualInput, setManualInput] = useState('');
  
  // Check for URL Hash on load (Guest Mode)
  useEffect(() => {
    const hash = window.location.hash.substring(1);
    if (hash) {
      handleGuestLoad(hash);
    }
  }, []);

  // --- INITIALIZATION ---

  const initPeer = () => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    
    pc.oniceconnectionstatechange = () => {
      console.log('ICE State:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'disconnected') {
        alert("Connection lost");
        setState(State.INIT);
      }
    };
    
    pcRef.current = pc;
    return pc;
  };

  const setupDataChannel = (dc: RTCDataChannel) => {
    dcRef.current = dc;
    dc.onopen = () => setState(State.CONNECTED);
    dc.onmessage = async (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.iv && payload.data && sharedKey) {
          // Decrypt message
          const text = await Security.decryptData(payload.data, payload.iv, sharedKey);
          setMessages(prev => [...prev, {
             id: Date.now().toString() + Math.random(),
             sender: 'peer',
             text,
             timestamp: Date.now()
          }]);
        }
      } catch (err) {
        console.error("Decryption failed", err);
      }
    };
  };

  // --- HOST FLOW ---

  const startHost = async () => {
    setState(State.HOST_GENERATING);
    try {
      // 1. Generate Security Key
      const key = await Security.generateKey();
      setSharedKey(key);
      const rawKey = await Security.exportKey(key);

      // 2. Create WebRTC Offer
      const pc = initPeer();
      const dc = pc.createDataChannel("secure-chat");
      setupDataChannel(dc);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 3. Wait for ICE
      await waitForIce(pc);

      // 4. Create Link
      const hash = LinkUtil.generateLinkHash(pc.localDescription, rawKey);
      const link = `${window.location.origin}${window.location.pathname}#${hash}`;
      setOfferLink(link);
      
      setState(State.HOST_WAITING);
      
      // Render QR
      setTimeout(() => {
        const container = document.getElementById('host-qr');
        if (container) {
          container.innerHTML = '';
          new QRCode(container, {
             text: link,
             width: 180,
             height: 180,
             colorDark : "#00ff9d",
             colorLight : "#0a0a0a",
             correctLevel : QRCode.CorrectLevel.L
          });
        }
      }, 100);

    } catch (e) {
      console.error(e);
      alert("Failed to initialize host");
      setState(State.INIT);
    }
  };

  const handleHostProcessAnswer = async () => {
    if (!manualInput.trim()) return;
    try {
      // Decompress if it's a hash, or raw JSON? 
      // User might paste the raw answer string from Guest
      let answerSDP = null;
      try {
        // Try decompressing first
        const payload = LinkUtil.parseLinkHash(manualInput);
        if (payload && payload.s) answerSDP = payload.s;
      } catch (e) {}

      if (!answerSDP) {
        // Try raw base64/json
        try {
            answerSDP = JSON.parse(atob(manualInput));
        } catch(e) {}
      }
      
      if (!answerSDP && manualInput.startsWith('{')) {
          answerSDP = JSON.parse(manualInput);
      }

      if (answerSDP && pcRef.current) {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(answerSDP));
      } else {
        alert("Invalid Answer Code");
      }
    } catch (e) {
      console.error(e);
      alert("Error connecting");
    }
  };

  // --- GUEST FLOW ---

  const handleGuestLoad = async (hash: string) => {
    setState(State.GUEST_PROCESSING);
    try {
      // 1. Parse Hash
      const data = LinkUtil.parseLinkHash(hash);
      if (!data || !data.s || !data.k) {
        alert("Invalid Invite Link");
        setState(State.INIT);
        return;
      }

      // 2. Import Key
      const key = await Security.importKey(data.k);
      setSharedKey(key);

      // 3. Init Peer
      const pc = initPeer();
      pc.ondatachannel = (e) => setupDataChannel(e.channel);

      // 4. Set Remote
      await pc.setRemoteDescription(new RTCSessionDescription(data.s));

      // 5. Create Answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // 6. Wait for ICE
      await waitForIce(pc);

      // 7. Display Answer Data
      // We don't need to send the key back, just the SDP
      const answerString = btoa(JSON.stringify(pc.localDescription));
      setAnswerData(answerString);
      setState(State.GUEST_ANSWER_READY);
      
      // Clean URL
      window.history.replaceState(null, '', window.location.pathname);

    } catch (e) {
      console.error(e);
      alert("Failed to join session");
      setState(State.INIT);
    }
  };

  // --- HELPERS ---

  const waitForIce = (pc: RTCPeerConnection) => {
    return new Promise<void>(resolve => {
      if (pc.iceGatheringState === 'complete') resolve();
      else {
        const check = () => {
          if (pc.iceGatheringState === 'complete') {
            pc.removeEventListener('icegatheringstatechange', check);
            resolve();
          }
        };
        pc.addEventListener('icegatheringstatechange', check);
      }
    });
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !sharedKey || !dcRef.current) return;

    try {
      const { iv, data } = await Security.encryptData(inputText, sharedKey);
      dcRef.current.send(JSON.stringify({ iv, data }));
      
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        sender: 'me',
        text: inputText,
        timestamp: Date.now()
      }]);
      setInputText('');
    } catch (e) {
      console.error("Send failed", e);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  // --- RENDER ---

  if (state === State.CONNECTED) {
    return (
      <div className="min-h-screen bg-background flex flex-col text-gray-100 font-sans">
        {/* Header */}
        <header className="p-4 border-b border-gray-800 bg-panel flex justify-between items-center shadow-lg z-10">
          <div className="flex items-center gap-3">
            <div className="relative">
                <div className="w-3 h-3 bg-primary rounded-full animate-pulse"></div>
                <div className="absolute inset-0 bg-primary rounded-full animate-ping opacity-20"></div>
            </div>
            <div>
              <h1 className="font-bold text-lg tracking-wider">SECURE<span className="text-primary">SYNC</span></h1>
              <div className="flex items-center gap-1 text-[10px] text-gray-500 font-mono">
                <Lock size={10} className="text-primary" />
                AES-256-GCM ENCRYPTED
              </div>
            </div>
          </div>
          <button onClick={() => window.location.reload()} className="text-xs text-red-500 hover:text-red-400 border border-red-900/50 px-3 py-1.5 rounded hover:bg-red-900/20 transition">
            TERMINATE
          </button>
        </header>

        {/* Chat Area */}
        <main className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="flex justify-center my-4">
            <span className="bg-gray-900 text-gray-500 text-xs px-3 py-1 rounded-full border border-gray-800 font-mono">
              Session Secured • {new Date().toLocaleTimeString()}
            </span>
          </div>
          {messages.map(msg => (
            <div key={msg.id} className={`flex ${msg.sender === 'me' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] sm:max-w-[70%] p-3 rounded-lg border ${
                msg.sender === 'me' 
                  ? 'bg-primary-dim border-primary/30 text-primary-50' 
                  : 'bg-panel border-gray-800 text-gray-200'
              }`}>
                <p className="text-sm">{msg.text}</p>
                <p className="text-[10px] opacity-50 mt-1 text-right font-mono">
                  {new Date(msg.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                </p>
              </div>
            </div>
          ))}
        </main>

        {/* Input */}
        <div className="p-4 bg-panel border-t border-gray-800">
          <form onSubmit={sendMessage} className="flex gap-2">
            <input 
              type="text" 
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              placeholder="Enter encrypted message..."
              className="flex-1 bg-background border border-gray-700 text-white px-4 py-3 rounded focus:outline-none focus:border-primary font-mono text-sm"
              autoFocus
            />
            <button type="submit" className="bg-primary text-black font-bold px-6 rounded hover:bg-green-400 transition-colors">
              SEND
            </button>
          </form>
        </div>
      </div>
    );
  }

  // --- SETUP SCREENS ---

  return (
    <div className="min-h-screen flex items-center justify-center p-4 font-sans bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-gray-900 to-black">
      <div className="max-w-md w-full bg-panel border border-gray-800 rounded-xl shadow-2xl overflow-hidden relative">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-primary to-transparent opacity-50"></div>
        
        {/* SETUP HOME */}
        {state === State.INIT && (
          <div className="p-8">
            <div className="flex justify-center mb-6">
              <Shield size={64} className="text-primary animate-pulse-slow" />
            </div>
            <h1 className="text-2xl font-bold text-center mb-2 text-white tracking-tight">SECURE<span className="text-primary">SYNC</span></h1>
            <p className="text-center text-gray-500 mb-8 text-sm">Military-grade offline communication.</p>
            
            <div className="space-y-4">
              <button 
                onClick={startHost}
                className="w-full bg-primary/10 hover:bg-primary/20 border border-primary/50 text-primary p-4 rounded-lg flex items-center justify-center gap-3 transition-all group"
              >
                <Monitor className="group-hover:scale-110 transition-transform" />
                <span className="font-bold">CREATE ROOM</span>
              </button>
              
              <div className="text-center text-xs text-gray-600 font-mono my-2">- OR -</div>
              
              <div className="relative">
                 <input 
                   disabled 
                   placeholder="Waiting for Invite Link..." 
                   className="w-full bg-black/50 border border-gray-800 p-3 rounded text-center text-gray-500 text-sm cursor-not-allowed"
                 />
                 <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <span className="bg-panel px-2 text-xs text-gray-400">Open a link to join</span>
                 </div>
              </div>
            </div>
          </div>
        )}

        {/* HOST WAITING */}
        {state === State.HOST_WAITING && (
          <div className="p-6">
            <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
              <Monitor size={18} className="text-primary" /> Room Ready
            </h2>
            
            <div className="bg-black p-4 rounded-lg mb-6 border border-gray-800 flex flex-col items-center">
              <div id="host-qr" className="bg-white p-2 rounded mb-4"></div>
              <p className="text-xs text-gray-500 mb-2">Scan to join securely</p>
              
              <div className="w-full flex gap-2">
                <input 
                  readOnly 
                  value={offerLink} 
                  className="flex-1 bg-gray-900 border border-gray-700 text-xs text-gray-400 p-2 rounded truncate font-mono" 
                />
                <button 
                  onClick={() => copyToClipboard(offerLink)}
                  className="p-2 bg-gray-800 hover:bg-gray-700 rounded text-white"
                >
                  <Copy size={14} />
                </button>
              </div>
            </div>

            <div className="border-t border-gray-800 pt-6">
              <h3 className="text-sm font-medium text-gray-300 mb-3">Complete Connection</h3>
              <p className="text-xs text-gray-500 mb-3">If the Guest cannot scan, paste their <span className="text-primary">Response Code</span> below:</p>
              <textarea
                value={manualInput}
                onChange={e => setManualInput(e.target.value)}
                placeholder="Paste Guest Response Code here..."
                className="w-full bg-black/50 border border-gray-700 rounded p-3 text-xs text-white font-mono h-20 mb-3 focus:border-primary focus:outline-none resize-none"
              />
              <button 
                onClick={handleHostProcessAnswer}
                className="w-full bg-secondary/20 hover:bg-secondary/30 text-white py-2 rounded font-medium text-sm transition-colors"
              >
                VERIFY & CONNECT
              </button>
            </div>
          </div>
        )}

        {/* GUEST PROCESSING */}
        {state === State.GUEST_PROCESSING && (
          <div className="p-12 flex flex-col items-center text-center">
            <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4"></div>
            <h2 className="text-white font-bold mb-2">Establishing Secure Uplink</h2>
            <p className="text-gray-500 text-sm">Verifying encryption keys...</p>
          </div>
        )}

        {/* GUEST ANSWER READY */}
        {state === State.GUEST_ANSWER_READY && (
          <div className="p-6">
            <div className="flex items-center gap-2 mb-4 text-green-400">
               <Check size={20} />
               <h2 className="font-bold">Keys Exchanged</h2>
            </div>
            <p className="text-sm text-gray-400 mb-6">
              To finish, copy this code and send it back to the Host (or paste it on their device).
            </p>

            <div className="bg-black p-4 rounded border border-gray-800 mb-6 relative group">
               <code className="text-xs text-primary font-mono break-all line-clamp-4">
                 {answerData}
               </code>
               <button 
                 onClick={() => copyToClipboard(answerData)}
                 className="absolute top-2 right-2 bg-gray-800 p-1.5 rounded text-white hover:bg-gray-700"
               >
                 <Copy size={14} />
               </button>
            </div>

            <div className="bg-yellow-900/20 border border-yellow-900/50 p-3 rounded flex gap-3">
              <AlertCircle size={16} className="text-yellow-500 shrink-0 mt-0.5" />
              <p className="text-xs text-yellow-200/70">
                Waiting for Host to confirm connection... The screen will update automatically.
              </p>
            </div>
          </div>
        )}

      </div>
      
      <div className="fixed bottom-4 text-[10px] text-gray-600 font-mono">
        SECURE_SYNC_V2.0 // AES-256-GCM // NO_LOGS
      </div>
    </div>
  );
}

'use client';

import {
  useStripe,
  useElements,
  CardNumberElement,
  CardExpiryElement,
  CardCvcElement
} from "@stripe/react-stripe-js";
import { FaCar, FaLock } from "react-icons/fa";
import { useEffect, useState } from "react";
import { io, Socket } from "socket.io-client";

interface Coord {
  lat: number;
  lon: number;
}

interface Slot {
  veicolo_id: number;
  start_datetime: string;
  durata: number;
  posti_richiesti: number;
  origine: Coord;
  destinazione: Coord;
  localitaOrigine?: string;
  localitaDestinazione?: string;
  pending_id?: number; // id generato dal server
}

interface Props {
  type: "prenota" | "richiedi";
  prezzo: number;
  slots: Slot[];
  loading: boolean;
  onConfirmSuccess: () => void;
  setLoading: (v: boolean) => void;
}

const stripeStyle = {
  style: {
    base: {
      fontSize: "16px",
      color: "#111827",
      "::placeholder": { color: "#9ca3af" }
    }
  }
};

let socket: Socket | null = null;

export default function StepPagamento({
  type,
  prezzo,
  slots,
  loading,
  onConfirmSuccess,
  setLoading
}: Props) {
  const stripe = useStripe();
  const elements = useElements();
  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
  const [message, setMessage] = useState<string | null>(null);
  const [paymentAuthorized, setPaymentAuthorized] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);

  // ------------------- SOCKET -------------------
  useEffect(() => {
    if (!slots || slots.length === 0 || !requestId) return;

    socket = io(API_URL);

    slots.forEach(slot => {
      if (!slot.pending_id) return;
      const roomId = slot.pending_id;
      socket?.on(`prenotazione_cliente_${roomId}`, (msg) => {
        console.log("📲 Evento socket:", msg);

        if (msg.status === "accettata") {
          setMessage("✅ Prenotazione confermata dall'autista!");
          onConfirmSuccess();
        }

        if (msg.status === "annullato") {
          setMessage("❌ Pagamento o prenotazione annullata");
          setLoading(false);
        }
      });
    });

    return () => {
      socket?.disconnect();
      socket = null;
    };
  }, [API_URL, slots, onConfirmSuccess, setLoading, requestId]);

  // ------------------- HANDLE PAYMENT -------------------
  const handlePayment = async () => {
    if (!stripe || !elements || !prezzo || prezzo <= 0) return;

    setLoading(true);
    setMessage(null);

    try {
      // 🔥 Normalizza slot per backend
      const safeSlots = slots.map(({ pending_id, ...slot }) => {
        if (!slot.start_datetime) throw new Error("start_datetime mancante");
        if (!slot.origine || !slot.destinazione) throw new Error("Origine o destinazione mancanti");

        return {
          ...slot,
          durata: `${slot.durata} minutes`,
        };
      });

      console.log("📤 Payload payment-intent:", { type, prezzo, slots: safeSlots });

      // ------------------- CHIAMATA BACKEND -------------------
      const res = await fetch(`${API_URL}/booking/payment-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ type, prezzo, slots: safeSlots })
      });

      if (!res.ok) {
        const text = await res.text();
        console.error("❌ Backend error:", text);
        alert("Errore backend payment-intent");
        setLoading(false);
        return;
      }

      const data = await res.json();

      if (!data.clientSecret || !data.pending || !data.requestId) {
        throw new Error("Client secret, pending o requestId mancante");
      }

      setRequestId(data.requestId);

      data.pending.forEach((p: any, idx: number) => {
        if (safeSlots[idx]) safeSlots[idx].pending_id = p.id;
      });

      const { error } = await stripe.confirmCardPayment(data.clientSecret, {
        payment_method: {
          card: elements.getElement(CardNumberElement)!,
          billing_details: { name: "Cliente TURENTU" }
        }
      });

      if (error) throw error;

      setPaymentAuthorized(true);
      setMessage("✅ Pagamento autorizzato! Attendere conferma dagli autisti.");
      setLoading(false);

    } catch (err: any) {
      console.error("❌ Errore pagamento:", err);
      alert(err.message || "Errore durante il pagamento");
      setLoading(false);
    }
  };

  // ------------------- UI -------------------
  return (
    <div className="flex flex-col gap-4">
      {/* Riepilogo slot */}
      <div className="bg-gray-50 rounded-xl p-4 space-y-3">
        {slots.map((slot, idx) => (
          <div key={idx} className="flex flex-col text-gray-700 border-b last:border-b-0 pb-2">
            <div className="flex items-center gap-2">
              <FaCar className="text-[#ff3036]" />
              <span className="font-medium">
                {slot.localitaOrigine ?? `${slot.origine.lat},${slot.origine.lon}`} → {slot.localitaDestinazione ?? `${slot.destinazione.lat},${slot.destinazione.lon}`}
              </span>
            </div>
            <div className="text-xs text-gray-500 flex justify-between">
              <span>🕒 {new Date(slot.start_datetime).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" })}</span>
              <span>👥 {slot.posti_richiesti} {slot.posti_richiesti > 1 ? "posti" : "posto"}</span>
            </div>
          </div>
        ))}
        <div className="text-3xl font-bold text-right">€ {prezzo.toFixed(2)}</div>
      </div>

      {/* Stripe fields */}
      {!paymentAuthorized && (
        <div className="bg-white rounded-xl border p-4 space-y-4">
          <div>
            <label className="text-xs text-gray-500">Numero carta</label>
            <div className="p-3 border rounded-lg">
              <CardNumberElement options={stripeStyle} />
            </div>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-gray-500">Scadenza</label>
              <div className="p-3 border rounded-lg">
                <CardExpiryElement options={stripeStyle} />
              </div>
            </div>

            <div className="flex-1">
              <label className="text-xs text-gray-500">CVC</label>
              <div className="p-3 border rounded-lg">
                <CardCvcElement options={stripeStyle} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sicurezza */}
      <div className="flex items-center justify-center gap-2 text-xs text-gray-500">
        <FaLock /> Pagamento sicuro Stripe
      </div>

      {/* Pulsante */}
      {!paymentAuthorized && (
        <button
          onClick={handlePayment}
          disabled={loading}
          className={`w-full py-3 rounded-lg text-white font-semibold ${loading ? "bg-[#ff3036]/70 cursor-not-allowed" : "bg-[#ff3036] hover:bg-[#e52b30]"}`}
        >
          {loading ? "⏳ Elaborazione..." : "Autorizza e paga"}
        </button>
      )}

      {/* Messaggio post autorizzazione */}
      {paymentAuthorized && message && (
        <div className="flex flex-col items-center gap-2 mt-4">
          <div className="w-12 h-12 flex items-center justify-center rounded-full bg-green-100 animate-pulse">
            <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div className="text-center text-sm font-semibold text-green-600">{message}</div>

          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-6 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition"
          >
            Chiudi
          </button>
        </div>
      )}
    </div>
  );
}

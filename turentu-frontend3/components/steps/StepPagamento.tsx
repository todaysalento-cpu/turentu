'use client';

import {
  useStripe,
  useElements,
  CardNumberElement,
  CardExpiryElement,
  CardCvcElement
} from "@stripe/react-stripe-js";
import {
  FaCar,
  FaLock,
  FaCheckCircle,
  FaCalendarAlt,
  FaInfoCircle,
  FaCcVisa,
  FaCcMastercard,
  FaCcAmex,
  FaRegCreditCard
} from "react-icons/fa";
import { useEffect, useState, forwardRef, useImperativeHandle } from "react";
import { io, Socket } from "socket.io-client";

interface Coord { lat: number; lon: number; }

export interface Slot {
  veicolo_id: number;
  start_datetime: string;
  durata_minuti: number;
  posti_richiesti: number;
  origine: Coord;
  destinazione: Coord;
  localitaOrigine: string;
  localitaDestinazione: string;
  pending_id?: number;
  posti_totali?: number;
  distanza?: number;
}

interface Props {
  type: "prenota" | "richiedi";
  prezzo: number;
  slots: Slot[];
  loading: boolean;
  setLoading: (v: boolean) => void;
  onConfirmSuccess: () => void;
}

let socket: Socket | null = null;

// Usando forwardRef per permettere al parent di chiamare handlePayment
const StepPagamentoCard = forwardRef(({ type, prezzo, slots, loading, setLoading, onConfirmSuccess }: Props, ref) => {
  const stripe = useStripe();
  const elements = useElements();
  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  const [message, setMessage] = useState<string | null>(null);
  const [paymentAuthorized, setPaymentAuthorized] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);

  const [cardComplete, setCardComplete] = useState(false);
  const [expiryComplete, setExpiryComplete] = useState(false);
  const [cvcComplete, setCvcComplete] = useState(false);
  const [cardBrand, setCardBrand] = useState<string>("unknown");
  const [stripeStyle, setStripeStyle] = useState<any>({
    style: {
      base: {
        fontSize: "16px",
        color: "#111827",
        fontFamily: "Roboto, sans-serif",
        lineHeight: "48px",
        letterSpacing: "0.5px",
        "::placeholder": { color: "#9ca3af" }
      },
      invalid: { color: "#dc2626" }
    }
  });

  useEffect(() => {
    const fontSize = window.innerWidth < 640 ? "14px" : "16px";
    setStripeStyle({
      style: { base: { ...stripeStyle.style.base, fontSize }, invalid: { color: "#dc2626" } }
    });
  }, []);

  useEffect(() => {
    if (!slots.length || !requestId) return;
    const validSlots = slots.filter(s => s.pending_id);
    if (!validSlots.length) return;

    socket = io(API_URL);
    validSlots.forEach(slot => {
      const roomId = slot.pending_id!;
      socket?.on(`prenotazione_cliente_${roomId}`, (msg: any) => {
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

    return () => { socket?.disconnect(); socket = null; };
  }, [API_URL, slots, requestId, onConfirmSuccess, setLoading]);

  // Metodo handlePayment esposto al parent tramite ref
 const handlePayment = async () => {
  if (!stripe || !elements || prezzo <= 0) return;

  console.log("🚀 Avvio handlePayment");
  console.log("💰 Prezzo:", prezzo);
  console.log("📦 Slots ricevuti:", slots);

  setLoading(true);
  setMessage(null);

  try {
    const safeSlots = slots.map(slot => ({
      veicolo_id: slot.veicolo_id,
      start_datetime: slot.start_datetime,
      durata_minuti: slot.durata_minuti ?? 30,
      posti_richiesti: slot.posti_richiesti,
      origine: slot.origine,
      destinazione: slot.destinazione,
      localitaOrigine: slot.localitaOrigine,
      localitaDestinazione: slot.localitaDestinazione,
      posti_totali: slot.posti_totali,
      distanzaKm: slot.distanza ?? 0
    }));

    console.log("📤 Payload inviato al backend:", {
      type,
      prezzo,
      slots: safeSlots
    });

    const res = await fetch(`${API_URL}/booking/payment-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ type, prezzo, slots: safeSlots })
    });

    console.log("📡 Response status:", res.status);

    if (!res.ok) {
      const text = await res.text();
      console.error("❌ Errore backend payment-intent:", text);
      throw new Error("Errore backend payment-intent");
    }

    const data = await res.json();

    console.log("📥 Risposta backend:", data);

    if (!data.clientSecret || !data.pending || !data.requestId) {
      console.error("❌ Dati mancanti dal backend:", data);
      throw new Error("Client secret, pending o requestId mancante");
    }

    console.log("🔑 Client secret ricevuto");
    console.log("🧾 Pending creati:", data.pending);
    console.log("🆔 RequestId:", data.requestId);

    setRequestId(data.requestId);

    data.pending.forEach((p: any, idx: number) => {
      if (safeSlots[idx]) safeSlots[idx].pending_id = p.id;
    });

    console.log("💳 Conferma pagamento Stripe...");

    const { error } = await stripe.confirmCardPayment(data.clientSecret, {
      payment_method: {
        card: elements.getElement(CardNumberElement)!,
        billing_details: { name: "Cliente TURENTU" }
      }
    });

    if (error) {
      console.error("❌ Errore Stripe:", error);
      throw error;
    }

    console.log("✅ Pagamento autorizzato");

    setPaymentAuthorized(true);
    setMessage("✅ Pagamento autorizzato! Attendere conferma dagli autisti.");
    setLoading(false);

  } catch (err: any) {
    console.error("🔥 ERRORE HANDLE PAYMENT:", err);
    alert(err.message || "Errore durante il pagamento");
    setLoading(false);
  }
};
  // Espongo handlePayment al parent tramite ref
  useImperativeHandle(ref, () => ({ handlePayment }));

  const renderCardIcon = () => {
    switch (cardBrand) {
      case "visa": return <FaCcVisa className="text-blue-600" />;
      case "mastercard": return <FaCcMastercard className="text-red-600" />;
      case "amex": return <FaCcAmex className="text-blue-500" />;
      default: return <FaRegCreditCard className="text-gray-400" />;
    }
  };

  return (
    <div className="relative flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-32 space-y-4">
        {slots.map((slot, idx) => (
          <div key={idx} className="flex flex-col text-gray-700 border-b last:border-b-0 pb-2">
            <div className="flex items-center gap-2">
              <FaCar className="text-[#ff3036]" />
              <span className="font-medium text-sm sm:text-base truncate">{slot.localitaOrigine} → {slot.localitaDestinazione}</span>
            </div>
            <div className="text-xs text-gray-500 flex justify-between">
              <span className="truncate">🕒 {new Date(slot.start_datetime).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" })}</span>
              <span>👥 {slot.posti_richiesti} {slot.posti_richiesti > 1 ? "posti" : "posto"}</span>
            </div>
          </div>
        ))}

        <div className="text-2xl sm:text-3xl font-bold text-right">€ {prezzo.toFixed(2)}</div>

        {!paymentAuthorized && (
          <div className="bg-gray-50 rounded-2xl p-4 space-y-4">
            <div className="flex items-center gap-2 text-gray-600 text-sm sm:text-base">
              {renderCardIcon()} <span>Dati carta</span>
            </div>

            <div className="relative bg-white rounded-xl border border-gray-200 px-4 py-3 shadow-sm flex items-center min-h-[56px] focus-within:border-[#ff3036]">
              <CardNumberElement
                options={stripeStyle}
                onChange={(e: any) => { setCardComplete(e.complete); setCardBrand(e.brand); }}
                className="w-full text-sm sm:text-base"
              />
              {cardComplete && <FaCheckCircle className="text-green-500 absolute right-4 top-1/2 -translate-y-1/2 animate-pulse" />}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="relative bg-white rounded-xl border border-gray-200 px-4 py-3 shadow-sm flex items-center min-h-[56px] focus-within:border-[#ff3036]">
                <CardExpiryElement
                  options={stripeStyle}
                  onChange={(e: any) => setExpiryComplete(e.complete)}
                  className="w-full text-sm sm:text-base"
                />
                {expiryComplete ? (
                  <FaCheckCircle className="text-green-500 absolute right-4 top-1/2 -translate-y-1/2 animate-pulse" />
                ) : (
                  <FaCalendarAlt className="text-gray-400 absolute right-4 top-1/2 -translate-y-1/2" />
                )}
              </div>

              <div className="relative bg-white rounded-xl border border-gray-200 px-4 py-3 shadow-sm flex items-center min-h-[56px] focus-within:border-[#ff3036]">
                <CardCvcElement
                  options={stripeStyle}
                  onChange={(e: any) => setCvcComplete(e.complete)}
                  className="w-full text-sm sm:text-base"
                />
                {cvcComplete ? (
                  <FaCheckCircle className="text-green-500 absolute right-4 top-1/2 -translate-y-1/2 animate-pulse" />
                ) : (
                  <FaInfoCircle className="text-gray-400 absolute right-4 top-1/2 -translate-y-1/2" />
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-2 text-xs text-gray-500 mt-2">
        <FaLock /> Pagamento sicuro Stripe
      </div>

      {paymentAuthorized && message && (
        <div className="mt-4 p-2 bg-green-100 text-green-800 rounded-lg text-center font-semibold animate-pulse">
          {message}
        </div>
      )}
    </div>
  );
});

export default StepPagamentoCard;
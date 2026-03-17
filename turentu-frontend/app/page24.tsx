'use client';

import { useState } from 'react';
import { useRicerca } from './ricerca/useRicerca';
import SearchForm from '../components/SearchForm';
import RisultatiSelection from '../components/RisultatiSelection';
import BookingFlow from '../components/BookingFlow';
import BoxInformativo from '../components/BoxInformativo';
import { FaArrowLeft } from 'react-icons/fa';

export default function RicercaPage() {
  const {
    form,
    dispatch,
    risultatiFiltrati,
    loading,
    filtroSlot,
    setFiltroSlot,
    selectedIds,
    setSelectedIds,
    bookingOpen,
    setBookingOpen,
    bookingType,
    handleSubmit,
    openBookingFlow,
    isMobile,
    user
  } = useRicerca();

  const [mobileView, setMobileView] = useState<'search' | 'results'>('search');
  const [showInfoBox, setShowInfoBox] = useState(true);

  const handleSubmitWrapper = async () => {
    await handleSubmit();
    if (isMobile) setMobileView('results');
  };

  const handleBackToSearch = () => setMobileView('search');

  return (
    <div className="w-full flex flex-col">
      
      {/* SEARCH FORM */}
      {(!isMobile || mobileView === 'search') && (
        <div className="w-full max-w-[1280px] mx-auto px-4 pt-2 md:pt-0">
          <SearchForm
            form={form}
            dispatch={dispatch}
            onSubmit={handleSubmitWrapper}
            loading={loading}
            isMobile={isMobile}
            showResults={!isMobile}
          />
        </div>
      )}

      {/* RISULTATI */}
      {(mobileView === 'results' || !isMobile) && (
        <div className="w-full max-w-[1280px] mx-auto px-4 mt-2 flex flex-col gap-2">
          <RisultatiSelection
            risultati={risultatiFiltrati}
            filtroSlot={filtroSlot || "Prenotabili"}
            selectedIds={selectedIds}
            onSelect={(id) => {
              if (filtroSlot === "Liberi") {
                setSelectedIds(prev =>
                  prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
                );
              } else {
                setSelectedIds([id]);
              }
            }}
            onAction={openBookingFlow}
            isMobile={isMobile}
            setFiltroSlot={setFiltroSlot}
            onBack={handleBackToSearch}
          />
        </div>
      )}

      {/* BOOKING FLOW */}
      {bookingOpen && risultatiFiltrati.length > 0 && user && (
        <BookingFlow
          open={bookingOpen}
          type={bookingType}
          risultatiSelezionati={risultatiFiltrati.filter(r => selectedIds.includes(r.id))}
          onClose={() => setBookingOpen(false)}
          localitaOrigine={form.localitaOrigine?.nome ?? ""}
          localitaDestinazione={form.localitaDestinazione?.nome ?? ""}
          datetime={form.start_datetime}
          posti={form.posti_richiesti}
          clienteId={user.id}
          coordOrigine={form.localitaOrigine?.coord}
          coordDestinazione={form.localitaDestinazione?.coord}
        />
      )}
    </div>
  );
}
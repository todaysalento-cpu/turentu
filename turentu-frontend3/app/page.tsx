'use client';

import { useState } from 'react';
import { useRicerca } from './ricerca/useRicerca';
import SearchForm from '../components/SearchForm';
import BookingFlow from '../components/BookingFlow';

export default function RicercaPage() {
  const {
    form,
    dispatch,
    risultatiFiltrati,
    loading,
    bookingOpen,
    setBookingOpen,
    bookingType,
    handleSubmit,
    isMobile,
    user
  } = useRicerca();

  const [mobileView, setMobileView] = useState<'search' | 'results'>('search');

  // 🔹 wrapper submit: esegue ricerca e apre subito il popup
  const handleSubmitWrapper = async () => {
    await handleSubmit();

    if (isMobile) setMobileView('results');

    // apre BookingFlow subito dopo la ricerca
    setBookingOpen(true);
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

      {/* BOOKING FLOW: popup con lista interna dei risultati */}
      {bookingOpen && risultatiFiltrati.length > 0 && user && (
        <BookingFlow
          open={bookingOpen}
          type={bookingType}
          risultati={risultatiFiltrati} // <-- passiamo tutti i risultati filtrati
          onClose={() => setBookingOpen(false)}
          localitaOrigine={form.localitaOrigine?.nome ?? ""}
          localitaDestinazione={form.localitaDestinazione?.nome ?? ""}
          datetime={form.start_datetime}
          posti={form.posti_richiesti}
          coordOrigine={form.localitaOrigine?.coord}
          coordDestinazione={form.localitaDestinazione?.coord}
        />
      )}
    </div>
  );
}
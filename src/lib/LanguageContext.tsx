import React, { createContext, useContext, useState, useCallback } from 'react';
import { translations } from './translate';
import { DisplayUnit } from './formatters';

export type { DisplayUnit };

interface LanguageContextType {
  lang: 'en' | 'vi';
  setLang: (lang: 'en' | 'vi') => void;
  unit: DisplayUnit;
  setUnit: (unit: DisplayUnit) => void;
  t: (text: string) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

const CACHE_KEY = 'app_language';
const UNIT_CACHE_KEY = 'app_unit';

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<'en' | 'vi'>(() => {
    const saved = localStorage.getItem(CACHE_KEY);
    return (saved === 'en' || saved === 'vi') ? saved : 'en';
  });
  const [unit, setUnitState] = useState<DisplayUnit>(() => {
    const saved = localStorage.getItem(UNIT_CACHE_KEY);
    return (saved === 'mm' || saved === 'inch') ? saved : 'mm';
  });

  const setLang = useCallback((newLang: 'en' | 'vi') => {
    setLangState(newLang);
    localStorage.setItem(CACHE_KEY, newLang);
  }, []);

  const setUnit = useCallback((newUnit: DisplayUnit) => {
    setUnitState(newUnit);
    localStorage.setItem(UNIT_CACHE_KEY, newUnit);
  }, []);

  const t = useCallback((text: string): string => {
    if (lang === 'vi') return text;
    return translations[text]?.en || text;
  }, [lang]);

  return (
    <LanguageContext.Provider value={{ lang, setLang, unit, setUnit, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}

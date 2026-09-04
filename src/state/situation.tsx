import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * 사용자가 입력한 '지금 나의 상황'과 서버가 고른 카드 id를
 * 앱이 켜져 있는 동안에만 메모리에 보관합니다.
 *
 * 주소(URL), 기기 저장소, 로그 어디에도 남기지 않습니다.
 * 화면 간 전달도 이 상태로만 합니다.
 */
type SituationContextValue = {
  situation: string;
  setSituation: (value: string) => void;
  /** 서버가 고른 Scripture Card id. 추천이 없으면 null. */
  selectedCardId: string | null;
  setSelectedCardId: (value: string | null) => void;
};

const SituationContext = createContext<SituationContextValue | null>(null);

export function SituationProvider({ children }: { children: ReactNode }) {
  const [situation, setSituation] = useState('');
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);

  const value = useMemo(
    () => ({ situation, setSituation, selectedCardId, setSelectedCardId }),
    [situation, selectedCardId],
  );

  return <SituationContext.Provider value={value}>{children}</SituationContext.Provider>;
}

export function useSituation() {
  const context = useContext(SituationContext);
  if (!context) {
    throw new Error('useSituation은 SituationProvider 안에서만 사용할 수 있습니다.');
  }
  return context;
}

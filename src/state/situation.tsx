import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { DeletionResult } from '@/lib/request-account-deletion';
import type { DomainChoiceOption } from '@/lib/request-recommendation';
import type { SituationDomain } from '@/data/situation-domains';

/**
 * 사용자가 입력한 '지금 나의 상황'과 서버가 고른 카드 id를
 * 앱이 켜져 있는 동안에만 메모리에 보관합니다.
 *
 * 주소(URL), 기기 저장소, 로그 어디에도 남기지 않습니다.
 * 화면 간 전달도 이 상태로만 합니다.
 *
 * 내 정보 삭제가 서버에서 확인되면 clearAfterDataDeletion으로 모두 비웁니다.
 *   화면이 뒤에 남아 있을 수 있으므로, 비웠다는 사실을 resetCount로 알립니다.
 *   각 화면은 이 값이 바뀌면 자기 상태를 처음으로 되돌리고,
 *   그 전에 보낸 요청의 답이 늦게 오면 버립니다.
 *
 * 내 정보 삭제 작업과 말씀 추천 요청은 동시에 진행하지 않습니다.
 *   삭제 작업의 잠금과 결과는 화면이 아니라 여기(앱 전체)에 둡니다.
 *   설정 화면이 닫혔다 다시 열려도, 두 개가 겹쳐 열려도 삭제 요청은 하나만 나갑니다.
 *   화면이 사라져도 이미 시작한 작업(서버 확인 뒤 이 기기 정리 포함)은 끝까지 진행합니다.
 *   이 상태는 메모리에만 있습니다. 앱이 강제로 종료되면 함께 사라집니다.
 */

/** 진행 중인 삭제 작업. deleting은 서버 삭제 요청부터, cleaning은 이 기기 정리 재시도다. */
export type DeletionTask = 'idle' | 'deleting' | 'cleaning';

type SituationContextValue = {
  situation: string;
  setSituation: (value: string) => void;
  /** 서버가 고른 Scripture Card id. 추천이 없으면 null. */
  selectedCardId: string | null;
  setSelectedCardId: (value: string | null) => void;
  /** 그 카드가 속한 삶의 영역(내부 표준 domain 값). 카드가 없으면 null. */
  selectedDomain: SituationDomain | null;
  /**
   * route가 domain_choice일 때, 사용자가 고를 두 후보 각각의 결과.
   * 그 밖에는 빈 배열이다.
   */
  domainChoiceOptions: DomainChoiceOption[];
  /**
   * 카드와 그 카드가 속한 영역을 함께 저장한다.
   * 일반 추천과 영역 선택 뒤의 추천 모두 이 함수 하나로 저장한다. 남아 있던 domainChoiceOptions는 비운다.
   */
  setRecommendation: (value: { cardId: string; selectedDomain: SituationDomain }) => void;
  /** route가 domain_choice일 때 두 option을 저장한다. 남아 있던 카드·영역은 비운다. */
  setDomainChoiceOptions: (options: DomainChoiceOption[]) => void;
  /**
   * 카드·영역·domainChoiceOptions를 모두 비운다.
   * 새 추천을 시작하기 전(이전 추천이 남아 있지 않게)과, 기도를 마치고 처음으로 돌아갈 때 쓴다.
   */
  clearRecommendation: () => void;
  /**
   * 영역 선택 화면에서 후보 하나를 고른 결과를 반영한다.
   *   - recommend option이면 selectedCardId·selectedDomain을 그 카드·영역으로 채운다.
   *   - ambiguous·no_coverage option이면 카드·영역만 null로 비운다.
   * 어느 경우든 domainChoiceOptions 두 개는 그대로 둔다.
   *   말씀·ambiguous·no_coverage 화면에서 뒤로 돌아왔을 때 같은 선택 화면에서
   *   다른 option을 다시 고를 수 있어야 하기 때문이다(setRecommendation/clearRecommendation과의 차이).
   */
  applyDomainChoiceOption: (option: DomainChoiceOption) => void;
  /** 삭제 뒤 앱 상태를 비운 횟수. 화면이 자기 상태를 되돌릴 때 쓴다. */
  resetCount: number;
  /**
   * 지금 이 순간의 resetCount.
   * 기다리던 답이 도착했을 때 그사이 삭제가 있었는지 볼 때 쓴다.
   * 화면이 다시 그려지기를 기다리지 않고 바로 최신 값을 준다.
   */
  getResetCount: () => number;
  /** 서버 삭제가 확인된 뒤에만 부른다. 상황과 말씀 선택을 비운다. */
  clearAfterDataDeletion: () => void;
  /** 말씀 추천 요청이 진행 중인지. */
  isRecommending: boolean;
  /**
   * 말씀 추천 요청을 시작한다고 알린다.
   * 내 정보 삭제 작업이 진행 중이면 시작하지 않고 false를 돌려준다.
   */
  beginRecommendation: () => boolean;
  /** 말씀 추천 요청이 끝났다고 알린다. 성공·실패·예외 어느 경우에도 부른다. */
  endRecommendation: () => void;
  /** 진행 중인 삭제 작업. */
  deletionTask: DeletionTask;
  /** 마지막으로 끝난 삭제 작업의 결과. 화면이 다시 만들어져도 볼 수 있다. */
  deletionOutcome: DeletionResult | null;
  /**
   * 삭제 작업을 하나만 실행한다.
   * 이미 삭제 작업이 진행 중이거나 추천 요청을 기다리는 중이면 시작하지 않고 false를 돌려준다.
   * 작업이 성공하든 실패하든 예외를 던지든, 끝나면 반드시 잠금을 푼다.
   */
  runDeletionTask: (
    kind: Exclude<DeletionTask, 'idle'>,
    task: () => Promise<DeletionResult>,
  ) => Promise<boolean>;
  /**
   * 결과를 확인했다고 알린다.
   * keepPendingCleanup이면, 서버 삭제 뒤 이 기기 정리가 남은 결과는 지우지 않고 남겨 둔다.
   * 그래야 화면을 다시 열었을 때 정리를 다시 시도할 수 있다.
   */
  acknowledgeDeletionOutcome: (options?: { keepPendingCleanup?: boolean }) => void;
};

const SituationContext = createContext<SituationContextValue | null>(null);

export function SituationProvider({ children }: { children: ReactNode }) {
  const [situation, setSituation] = useState('');
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedDomain, setSelectedDomain] = useState<SituationDomain | null>(null);
  const [domainChoiceOptions, setDomainChoiceOptionsState] = useState<DomainChoiceOption[]>([]);
  const [resetCount, setResetCount] = useState(0);
  const resetCountRef = useRef(0);

  // 화면이 다시 그려지기를 기다리지 않고 바로 판단해야 하므로 ref에도 함께 둔다.
  const [isRecommending, setIsRecommending] = useState(false);
  const recommendingRef = useRef(false);
  const [deletionTask, setDeletionTask] = useState<DeletionTask>('idle');
  const deletionTaskRef = useRef<DeletionTask>('idle');
  const [deletionOutcome, setDeletionOutcome] = useState<DeletionResult | null>(null);

  const getResetCount = useCallback(() => resetCountRef.current, []);

  const clearAfterDataDeletion = useCallback(() => {
    // 먼저 바로 올린다. 이 순간 이후 도착하는 답은 즉시 버려진다.
    resetCountRef.current += 1;
    setResetCount(resetCountRef.current);
    setSituation('');
    setSelectedCardId(null);
    setSelectedDomain(null);
    setDomainChoiceOptionsState([]);
  }, []);

  /**
   * 카드와 그 카드가 속한 영역을 함께 저장한다.
   * 일반 추천의 primaryDomain이든, 영역 선택 뒤 고른 option의 카드든 이 함수 하나로 저장한다.
   */
  const setRecommendation = useCallback((value: { cardId: string; selectedDomain: SituationDomain }) => {
    setSelectedCardId(value.cardId);
    setSelectedDomain(value.selectedDomain);
    setDomainChoiceOptionsState([]);
  }, []);

  /** domain_choice route에서 받은 두 option을 저장한다. 아직 카드와 영역은 정해지지 않았다. */
  const setDomainChoiceOptions = useCallback((options: DomainChoiceOption[]) => {
    setSelectedCardId(null);
    setSelectedDomain(null);
    setDomainChoiceOptionsState(options);
  }, []);

  /** 새 추천을 시작하기 전과, 기도를 마치고 처음으로 돌아갈 때 이전 추천을 모두 비운다. */
  const clearRecommendation = useCallback(() => {
    setSelectedCardId(null);
    setSelectedDomain(null);
    setDomainChoiceOptionsState([]);
  }, []);

  /**
   * 영역 선택 화면에서 후보 하나를 고른 결과를 반영한다.
   * domainChoiceOptions는 건드리지 않는다 — 뒤로 돌아왔을 때 같은 두 후보로 다시 고를 수 있어야 한다.
   */
  const applyDomainChoiceOption = useCallback((option: DomainChoiceOption) => {
    if (option.resolution === 'recommend' && option.selectedCardId) {
      setSelectedCardId(option.selectedCardId);
      setSelectedDomain(option.domain);
      return;
    }
    // ambiguous·no_coverage는 고를 카드가 없다.
    setSelectedCardId(null);
    setSelectedDomain(null);
  }, []);

  const beginRecommendation = useCallback(() => {
    if (deletionTaskRef.current !== 'idle') return false;
    recommendingRef.current = true;
    setIsRecommending(true);
    return true;
  }, []);

  const endRecommendation = useCallback(() => {
    recommendingRef.current = false;
    setIsRecommending(false);
  }, []);

  const runDeletionTask = useCallback(
    async (kind: Exclude<DeletionTask, 'idle'>, task: () => Promise<DeletionResult>) => {
      if (deletionTaskRef.current !== 'idle' || recommendingRef.current) return false;

      deletionTaskRef.current = kind;
      setDeletionTask(kind);
      setDeletionOutcome(null);

      try {
        let result: DeletionResult;
        try {
          result = await task();
        } catch {
          // 작업 함수는 예외를 던지지 않게 만들었다. 그래도 던지면 성공으로 바꾸지 않는다.
          // 정리 재시도는 서버 삭제가 이미 확인된 뒤에만 하므로 그 사실은 유지한다.
          result = kind === 'cleaning' ? 'deleted-local-cleanup-failed' : 'unconfirmed';
        }
        setDeletionOutcome(result);
      } finally {
        deletionTaskRef.current = 'idle';
        setDeletionTask('idle');
      }
      return true;
    },
    [],
  );

  const acknowledgeDeletionOutcome = useCallback(
    (options: { keepPendingCleanup?: boolean } = {}) => {
      setDeletionOutcome((previous) =>
        options.keepPendingCleanup && previous === 'deleted-local-cleanup-failed' ? previous : null,
      );
    },
    [],
  );

  const value = useMemo(
    () => ({
      situation,
      setSituation,
      selectedCardId,
      setSelectedCardId,
      selectedDomain,
      domainChoiceOptions,
      setRecommendation,
      setDomainChoiceOptions,
      clearRecommendation,
      applyDomainChoiceOption,
      resetCount,
      getResetCount,
      clearAfterDataDeletion,
      isRecommending,
      beginRecommendation,
      endRecommendation,
      deletionTask,
      deletionOutcome,
      runDeletionTask,
      acknowledgeDeletionOutcome,
    }),
    [
      situation,
      selectedCardId,
      selectedDomain,
      domainChoiceOptions,
      setRecommendation,
      setDomainChoiceOptions,
      clearRecommendation,
      applyDomainChoiceOption,
      resetCount,
      getResetCount,
      clearAfterDataDeletion,
      isRecommending,
      beginRecommendation,
      endRecommendation,
      deletionTask,
      deletionOutcome,
      runDeletionTask,
      acknowledgeDeletionOutcome,
    ],
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

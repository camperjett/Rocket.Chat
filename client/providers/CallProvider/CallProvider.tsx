import React, { useMemo, FC } from 'react';

import { CallContext, CallContextValue } from '../../contexts/CallContext';
import {
	isUseVoipClientResultError,
	isUseVoipClientResultLoading,
	useVoipClient,
} from './hooks/useVoipClient';

export const CallProvider: FC = ({ children }) => {
	// TODO: Test Settings and return false if its disabled (based on the settings)
	const result = useVoipClient();

	// type CallContextReady = {
	// 	enabled: true;
	// 	ready: true;
	// 	registrationInfo: IRegistrationInfo; // TODO: Remove after delete the example
	// 	voipClient: VoIPUser;
	// 	actions: CallActions;
	// };
	const contextValue: CallContextValue = useMemo(() => {
		if (isUseVoipClientResultError(result)) {
			return {
				enabled: true,
				ready: false,
				error: result.error,
			};
		}
		if (isUseVoipClientResultLoading(result)) {
			return {
				enabled: true,
				ready: false,
			};
		}

		const { registrationInfo, voipClient } = result;

		return {
			enabled: true,
			ready: true,
			registrationInfo,
			voipClient,
			actions: {
				mute: (): void => undefined, // voipClient.mute(),
				unmute: (): void => undefined, // voipClient.unmute()
				pause: (): void => undefined, // voipClient.pause()
				resume: (): void => undefined, // voipClient.resume()
				end: (): Promise<unknown> => voipClient.endCall(),
				pickUp: (): Promise<unknown> => voipClient.acceptCall(),
				reject: (): Promise<unknown> => voipClient.rejectCall(),
			},
		};
	}, [result]);
	return <CallContext.Provider children={children} value={contextValue} />;
};
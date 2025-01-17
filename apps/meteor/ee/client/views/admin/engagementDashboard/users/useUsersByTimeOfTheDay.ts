import { useEndpoint } from '@rocket.chat/ui-contexts';
import { useQuery } from 'react-query';

import { getPeriodRange, Period } from '../dataView/periods';

type UseUsersByTimeOfTheDayOptions = { period: Period['key']; utc: boolean };

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export const useUsersByTimeOfTheDay = ({ period, utc }: UseUsersByTimeOfTheDayOptions) => {
	const getUsersByTimeOfTheDay = useEndpoint('GET', '/v1/engagement-dashboard/users/users-by-time-of-the-day-in-a-week');

	return useQuery(
		['admin/engagement-dashboard/users/users-by-time-of-the-day', { period, utc }],
		async () => {
			const { start, end } = getPeriodRange(period, utc);

			const response = await getUsersByTimeOfTheDay({
				start,
				end,
			});

			return response
				? {
						...response,
						start,
						end,
				  }
				: undefined;
		},
		{
			refetchInterval: 5 * 60 * 1000,
		},
	);
};

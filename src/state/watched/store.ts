import { DetailedMeta, getMetaFromId } from "@/backend/metadata/getmeta";
import { searchForMedia } from "@/backend/metadata/search";
import { MWMediaMeta, MWMediaType } from "@/backend/metadata/types";
import { versionedStoreBuilder } from "@/utils/storage";
import { WatchedStoreData, WatchedStoreItem } from "./context";

interface OldMediaBase {
  mediaId: number;
  mediaType: MWMediaType;
  percentage: number;
  progress: number;
  providerId: string;
  title: string;
  year: number;
}

interface OldMovie extends OldMediaBase {
  mediaType: MWMediaType.MOVIE;
}

interface OldSeries extends OldMediaBase {
  mediaType: MWMediaType.SERIES;
  episodeId: number;
  seasonId: number;
}

interface OldData {
  items: (OldMovie | OldSeries)[];
}

export const VideoProgressStore = versionedStoreBuilder()
  .setKey("video-progress")
  .addVersion({
    version: 0,
  })
  .addVersion({
    version: 1,
    migrate() {
      return {
        items: [],
      };
    },
  })
  .addVersion({
    version: 2,
    migrate(old: OldData) {
      requestAnimationFrame(() => {
        // eslint-disable-next-line no-use-before-define
        migrateV2(old);
      });
      return {
        items: [],
      };
    },
    create() {
      return {
        items: [],
      };
    },
  })
  .build();

async function migrateV2(old: OldData) {
  const oldData = old;
  if (!oldData) return;

  const uniqueMedias: Record<string, any> = {};
  oldData.items.forEach((item: any) => {
    if (uniqueMedias[item.mediaId]) return;
    uniqueMedias[item.mediaId] = item;
  });

  const yearsAreClose = (a: number, b: number) => {
    return Math.abs(a - b) <= 1;
  };

  const mediaMetas: Record<string, Record<string, DetailedMeta | null>> = {};

  const relevantItems = await Promise.all(
    Object.values(uniqueMedias).map(async (item) => {
      const year = Number(item.year.toString().split("-")[0]);
      const data = await searchForMedia({
        searchQuery: `${item.title} ${year}`,
        type: item.mediaType,
      });
      const relevantItem = data.find((res) =>
        yearsAreClose(Number(res.year), year)
      );
      if (!relevantItem) {
        console.error("No item");
        return;
      }
      return {
        id: item.mediaId,
        data: relevantItem,
      };
    })
  );

  for (const item of relevantItems.filter(Boolean)) {
    if (!item) continue;

    let keys: (string | null)[][] = [["0", "0"]];
    if (item.data.type === "series") {
      const meta = await getMetaFromId(item.data.type, item.data.id);
      if (!meta || !meta?.meta.seasons) return;
      const seasonNumbers = [
        ...new Set(
          oldData.items
            .filter((watchedEntry: any) => watchedEntry.mediaId === item.id)
            .map((watchedEntry: any) => watchedEntry.seasonId)
        ),
      ];
      const seasons = seasonNumbers
        .map((num) => ({
          num,
          season: meta.meta?.seasons?.[(num as number) - 1],
        }))
        .filter(Boolean);
      keys = seasons
        .map((season) => (season ? [season.num, season?.season?.id] : []))
        .filter((entry) => entry.length > 0); // Stupid TypeScript
    }

    if (!mediaMetas[item.id]) mediaMetas[item.id] = {};
    await Promise.all(
      keys.map(async ([key, id]) => {
        if (!key) return;
        mediaMetas[item.id][key] = await getMetaFromId(
          item.data.type,
          item.data.id,
          id === "0" || id === null ? undefined : id
        );
      })
    );
  }

  // We've got all the metadata you can dream of now
  // Now let's convert stuff into the new format.
  interface WatchedStoreDataWithVersion extends WatchedStoreData {
    "--version": number;
  }
  const newData: WatchedStoreDataWithVersion = {
    ...oldData,
    items: [],
    "--version": 2,
  };

  for (const oldWatched of oldData.items) {
    if (oldWatched.mediaType === "movie") {
      if (!mediaMetas[oldWatched.mediaId]["0"]?.meta) continue;

      const newItem: WatchedStoreItem = {
        item: {
          meta: mediaMetas[oldWatched.mediaId]["0"]?.meta as MWMediaMeta,
        },
        progress: oldWatched.progress,
        percentage: oldWatched.percentage,
        watchedAt: Date.now(), // There was no watchedAt in V2
      };

      oldData.items = oldData.items.filter(
        (item) => JSON.stringify(item) !== JSON.stringify(oldWatched)
      );
      newData.items.push(newItem);
    } else if (oldWatched.mediaType === "series") {
      if (!mediaMetas[oldWatched.mediaId][oldWatched.seasonId]?.meta) continue;

      const meta = mediaMetas[oldWatched.mediaId][oldWatched.seasonId]
        ?.meta as MWMediaMeta;

      if (meta.type !== "series") return;

      const newItem: WatchedStoreItem = {
        item: {
          meta,
          series: {
            episode: Number(oldWatched.episodeId),
            season: Number(oldWatched.seasonId),
            seasonId: meta.seasonData.id,
            episodeId:
              meta.seasonData.episodes[Number(oldWatched.episodeId) - 1].id,
          },
        },
        progress: oldWatched.progress,
        percentage: oldWatched.percentage,
        watchedAt: Date.now(), // There was no watchedAt in V2
      };

      if (
        newData.items.find(
          (item) =>
            item.item.meta.id === newItem.item.meta.id &&
            item.item.series?.episodeId === newItem.item.series?.episodeId
        )
      )
        continue;

      oldData.items = oldData.items.filter(
        (item) => JSON.stringify(item) !== JSON.stringify(oldWatched)
      );
      newData.items.push(newItem);
    }
  }

  console.log(JSON.stringify(old), JSON.stringify(newData));
  if (JSON.stringify(old.items) !== JSON.stringify(newData.items)) {
    console.log(newData);
    VideoProgressStore.get().save(newData);
  }
}

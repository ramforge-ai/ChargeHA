import { StationPicker } from "./StationPicker.tsx";
export const goodweGallery = {
  id: "goodwe-sems",
  title: "GoodWe SEMS",
  description: "Static station discovery results; no account or network calls.",
  specimens: [
    {
      label: "Station selection",
      Component: () => (
        <StationPicker
          stations={[{ id: "example-home", name: "Example home" }, {
            id: "example-garage",
            name: "Example garage",
          }]}
          selectedStationId="example-home"
          searched
          onSelect={() => {}}
        />
      ),
    },
    {
      label: "No stations",
      Component: () => (
        <StationPicker
          stations={[]}
          selectedStationId=""
          searched
          onSelect={() => {}}
        />
      ),
    },
  ],
};

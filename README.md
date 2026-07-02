iRun Turf War
A real-world, multiplayer location-based fitness app designed for Kathmandu Valley. Players lace up their running shoes, hit the streets, and physically run to claim territory on a live digital map. By transforming real-world routes into personal kingdoms, iRun Turf War merges community fitness with high-stakes territory conquest.

⚙️ Core Gameplay Rules
1. The Dynamic Route Trace
When a user starts a run, the app utilizes background GPS location services to track their path. Upon completion, this entire path is converted into a series of connected street segments that glow on the global map in the user's custom color.

2. Overlapping Turf (Street-Level Stealing)
Challengers do not steal an entire route by crossing it. If Player B runs through a street intersection or segment currently owned by Player A, Player B only takes ownership of the specific street segments they physically ran over. Player A retains the rest of their un-crossed route.

3. The 24-Hour Expiration
To maintain high map velocity and engagement, all claimed territories have a baseline lifespan of 24 hours. If a street segment is not defended or refreshed by the owner, it fades back to neutral gray, opening up the neighborhood for new competitors.

4. The Social Athlete Profile
When a user taps on any glowing street segment within Kathmandu, a sleek profile card pops up displaying the current owner's profile picture, running club affiliation, and their fastest recorded pace on that exact segment to foster local rivalry.

🗺️ Tech Stack & Architecture
To ensure high performance and low battery consumption over local mobile networks (Ncell/NTC), the system architecture isolates spatial calculations on the backend and batches GPS data on the frontend.
LayerTechnologyOperational PurposeFrontendFlutterCross-platform codebase (iOS & Android) with native integration for background location permissions.Backend APINode.js (TypeScript)Scalable, asynchronous event handling for live multiplayer game state updates.Spatial DatabasePostgreSQL + PostGISHandles sub-millisecond geographic line intersections ($ST\_Intersection$) to split and transfer street ownership.Real-Time LayerRedis + WebSocketsPushes instant "Turf Stolen" notifications and updates the live map layer globally.Map RenderingMapbox SDKCustom dark-themed vector maps tailored for vibrant neon coordinate line overlays.


📁 Repository Structure
/irun-turf-war
│
├── /frontend-flutter      # Cross-platform mobile client application
│   ├── /lib/screens       # Live map view, profile dashboards, active tracking UI
│   └── /lib/services      # Background GPS batching, local syncing, & API client
│
├── /backend-node          # Central API service & spatial processing engine
│   ├── /src/controllers   # Route calculation algorithms & territory theft logic
│   └── /src/models        # PostGIS database models for spatial line strings
│
└── /infrastructure        # DevOps infrastructure configurations
    ├── /docker            # Isolated container environments for local dev
    └── /db-scripts        # Initial PostGIS extensions and geographic indexing

🚀 Performance & Network Optimization
Because continuous server pings can rapidly drain device batteries and crash network threads, the application enforces a strict Data Budget:

Local Batching: While running, the mobile client records coordinate streams locally.

Interval Syncing: Data packets are batched and uploaded to the server in optimized intervals (every 15 seconds) rather than every second.

Offline Resilience: If mobile data drops in dense or patchy coverage zones around the valley, the app queues the spatial coordinates locally and pushes them automatically once a stable connection is re-established.

🛠️ Setup & Local Development
Prerequisites
Flutter SDK (3.x or higher)

Node.js (v18 or higher)

Docker Desktop (with Compose support)

Spinning Up the Environment
Clone the repository to your local directory.

Initialize the backend, PostGIS database, and Redis cache instances using container services:

Bash
docker-compose up -d --build
Navigate to the frontend directory, install dependencies, and run the client application on your connected test device:

Bash
cd frontend-flutter
flutter pub get
flutter run
    

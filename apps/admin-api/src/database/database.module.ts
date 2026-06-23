import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { Neo4jService } from './neo4j.service';

@Global()
@Module({
  providers: [DatabaseService, Neo4jService],
  exports: [DatabaseService, Neo4jService],
})
export class DatabaseModule {}

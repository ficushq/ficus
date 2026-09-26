CREATE TABLE "agent_question_delivery_acknowledgements" (
	"question_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_question_delivery_acknowledgements_question_id_user_id_pk" PRIMARY KEY("question_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "agent_question_delivery_acknowledgements" ADD CONSTRAINT "agent_question_delivery_acknowledgements_question_id_agent_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."agent_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_question_delivery_acknowledgements" ADD CONSTRAINT "agent_question_delivery_acknowledgements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;